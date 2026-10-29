import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SpritesClient } from "@fly/sprites";
import { type Db, runs } from "@harness/db";
import type { AgentId, RunId } from "@harness/shared";
import { eq } from "drizzle-orm";
import { mintAgentToken } from "./agent-token.js";
import type { Config } from "./config.js";
import { REPO_DIR, RUNNER_DIR, WORKTREES_DIR } from "./provision.js";
import { type KnownSecrets, redact } from "./redact.js";
import { failRun, isActive } from "./runs.js";
import { execInSprite, startDetached, writeSpriteFile } from "./sprites.js";

const RUNNER = `${RUNNER_DIR}/runner.mjs`;
// the prompt rides in a file: env reaches the session as URL query params, too short for a long prompt.
// the run id in argv is what `runnerPattern` matches; the runner itself ignores it
const RUNNER_COMMAND = `PROMPT="$(cat "$PROMPT_FILE")" && export PROMPT && exec node ${RUNNER} "$RUN_ID"`;

/** `pgrep -f`/`pkill -f` pattern matching only this run's runner, never its Claude child. */
const runnerPattern = (runId: RunId) =>
  `^node ${RUNNER.replaceAll(".", "\\.")} ${runId}$`;

/**
 * SIGTERMs the run's runner, which aborts its Claude session and commits before exiting. A failure
 * is logged, not thrown; a runner already gone counts as signalled.
 */
export async function signalRunner(
  sprites: SpritesClient,
  spriteName: string,
  runId: RunId,
  log: (line: string) => void,
): Promise<void> {
  try {
    const out = await execInSprite(sprites, spriteName, [
      "pkill",
      "-TERM",
      "-f",
      runnerPattern(runId),
    ]);
    // pkill exits 1 when nothing matched
    if (out.exitCode > 1) {
      log(`signalling the runner of ${runId} failed: ${out.stderr.trim()}`);
    }
  } catch (err) {
    log(`signalling the runner of ${runId} failed: ${err}`);
  }
}

// bounded: a runner that outlives the wait loses whatever its commit hadn't written
const AWAIT_RUNNER_EXIT = `for _ in $(seq 30); do pgrep -f "$2" >/dev/null || break; sleep 1; done; `;
// a worktree the runner never created (or whose directory is gone) counts as removed
const REMOVE_WORKTREE = `git worktree remove --force "$1" || ! test -e "$1"`;

/**
 * Removes the agent's worktree; its branch stays. With `stoppedRunId`, first waits for that run's
 * runner to exit, so the commit it makes on SIGTERM lands. Throws when the removal fails.
 */
export async function removeWorktree(
  sprites: SpritesClient,
  spriteName: string,
  agentId: AgentId,
  stoppedRunId: RunId | null,
): Promise<void> {
  const path = `${WORKTREES_DIR}/${agentId}`;
  const argv: [string, ...string[]] = stoppedRunId
    ? [
        "bash",
        "-c",
        AWAIT_RUNNER_EXIT + REMOVE_WORKTREE,
        "_",
        path,
        runnerPattern(stoppedRunId),
      ]
    : ["bash", "-c", REMOVE_WORKTREE, "_", path];
  const out = await execInSprite(sprites, spriteName, argv, { cwd: REPO_DIR });
  if (out.exitCode !== 0) {
    throw new Error(`exit ${out.exitCode}: ${out.stderr.trim()}`);
  }
}

type Deps = {
  db: Db;
  config: Config;
  secrets: KnownSecrets;
  sprites: SpritesClient;
  log: (line: string) => void;
};
export type Launch = {
  spriteName: string;
  agentId: AgentId;
  runId: RunId;
  prompt: string;
  /** The Claude session to resume; null starts a fresh one. */
  sessionId: string | null;
};

/** Starts runners in the background; a launch that fails fails its run with a redacted `launch_failed` error. */
export function createLauncher({ db, config, secrets, sprites, log }: Deps) {
  let bundle: Promise<{ bytes: Buffer; sha256: string }> | undefined;
  // read once: the bundle ships with this build of the API
  const loadBundle = () => {
    bundle ??= readFile(config.runnerBundlePath).then((bytes) => ({
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }));
    bundle.catch(() => {
      bundle = undefined;
    });
    return bundle;
  };

  async function ensureBundle(spriteName: string): Promise<void> {
    const { bytes, sha256 } = await loadBundle();
    const current = await execInSprite(sprites, spriteName, [
      "sha256sum",
      RUNNER,
    ]);
    const onSprite = current.exitCode === 0 ? current.stdout.split(" ")[0] : "";
    if (onSprite !== sha256) {
      await writeSpriteFile(sprites, spriteName, RUNNER, bytes);
    }
  }

  async function run(launch: Launch, agentToken: string): Promise<void> {
    await ensureBundle(launch.spriteName);
    const promptFile = `/workspace/runs/${launch.runId}.prompt`;
    await writeSpriteFile(
      sprites,
      launch.spriteName,
      promptFile,
      launch.prompt,
    );
    // a stop that landed mid-launch found no runner to signal
    const current = db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, launch.runId))
      .get();
    if (!current || !isActive(current.status)) {
      log(`${launch.runId} ended before its runner started`);
      return;
    }
    await startDetached(
      sprites,
      launch.spriteName,
      ["bash", "-c", RUNNER_COMMAND],
      {
        cwd: REPO_DIR,
        env: {
          AGENT_ID: launch.agentId,
          RUN_ID: launch.runId,
          API_BASE_URL: config.publicBaseUrl,
          AGENT_TOKEN: agentToken,
          CLAUDE_CODE_OAUTH_TOKEN: config.claudeOauthToken,
          PROMPT_FILE: promptFile,
          REPO_DIR,
          WORKTREES_DIR,
          ...(launch.sessionId ? { SESSION_ID: launch.sessionId } : {}),
        },
      },
    );
  }

  return {
    start(launch: Launch): void {
      const agentToken = mintAgentToken(config.apiKey, launch.runId);
      run(launch, agentToken)
        .catch((err: unknown) => {
          // the SDK's socket errors quote the session URL, which carries the env
          const detail = redact(
            err instanceof Error ? err.message : String(err),
            [...secrets.values(), agentToken],
          );
          log(`launching ${launch.runId} failed: ${detail}`);
          db.transaction(
            (tx) => failRun(tx, launch.runId, `launch_failed: ${detail}`),
            { behavior: "immediate" },
          );
        })
        .catch((err: unknown) => {
          log(`launching ${launch.runId} could not record its outcome: ${err}`);
        });
    },
  };
}

export type Launcher = ReturnType<typeof createLauncher>;
