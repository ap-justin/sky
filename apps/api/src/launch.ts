import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { APIError, type SpritesClient } from "@fly/sprites";
import { type Db, environments, runs } from "@sky/db";
import type { AgentId, EnvironmentId, RunId } from "@sky/shared";
import { and, eq } from "drizzle-orm";
import { mintAgentToken } from "./agent-token.js";
import type { Config } from "./config.js";
import {
  REPO_DIR,
  RUNNER_DIR,
  WITH_PACKAGE_MANAGERS,
  WORKTREES_DIR,
} from "./provision.js";
import { type KnownSecrets, redact } from "./redact.js";
import { failRun, isActive } from "./runs.js";
import { openEnvSecrets, openRunEnvVars } from "./secrets.js";
import {
  execInSprite,
  spriteExists,
  startDetached,
  writeSpriteFile,
} from "./sprites.js";

const RUNNER = `${RUNNER_DIR}/runner.mjs`;
// the session's env reaches the sprite as URL query params, so secrets ride in ENV_FILE, sourced
// then deleted, and the prompt in PROMPT_FILE, which a query param is too short for;
// the run id in argv is what `runnerPattern` matches; the runner itself ignores it
const RUNNER_COMMAND = `${WITH_PACKAGE_MANAGERS} && set -a && . "$ENV_FILE" && set +a && rm -f "$ENV_FILE" && PROMPT="$(cat "$PROMPT_FILE")" && export PROMPT && exec node ${RUNNER} "$RUN_ID"`;

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** `export NAME='value'` lines for sh to source; later names override earlier ones. */
const envFile = (vars: Iterable<[string, string]>) =>
  [...vars]
    .map(([name, value]) => `export ${name}=${shellQuote(value)}\n`)
    .join("");

/**
 * `pgrep -f`/`pkill -f` pattern matching only this run's runner, never its Claude child. Unanchored,
 * so a node started by its full path matches; the bash parent's argv holds a literal `"$RUN_ID"`,
 * and the matcher's own argv a `\.` and a trailing `$`, so neither matches.
 */
export const runnerPattern = (runId: RunId) =>
  `${RUNNER.replaceAll(".", "\\.")} ${runId}$`;

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

// exit 0 once nothing matches, 1 while a runner still does after 30 s; pgrep's own errors exit 2
const AWAIT_EXIT_OR_REPORT = `for _ in $(seq 30); do pgrep -f "$1" >/dev/null; case $? in 1) exit 0;; 0) sleep 1;; *) exit 2;; esac; done; exit 1`;

/**
 * Waits up to 30 s for the run's runner to exit: true once it is gone, false while it lives on.
 * Throws when the sprite can't answer.
 */
export async function awaitRunnerExit(
  sprites: SpritesClient,
  spriteName: string,
  runId: RunId,
): Promise<boolean> {
  const out = await execInSprite(sprites, spriteName, [
    "bash",
    "-c",
    AWAIT_EXIT_OR_REPORT,
    "_",
    runnerPattern(runId),
  ]);
  if (out.exitCode === 0) return true;
  if (out.exitCode === 1) return false;
  throw new Error(`exit ${out.exitCode}: ${out.stderr.trim()}`);
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
  nudgeDeliveries: () => void;
  /** How long a launch stays attached to catch a runner that dies at start. */
  watchMs: number;
};
export type Launch = {
  envId: EnvironmentId;
  spriteName: string;
  agentId: AgentId;
  runId: RunId;
  prompt: string;
  /** The Claude session to resume; null starts a fresh one. */
  sessionId: string | null;
  /** The env's tool patterns that wait for an approval. */
  approvalPolicy: string[];
};

/** Starts runners in the background; a launch that fails fails its run with a redacted `launch_failed` error. */
export function createLauncher({
  db,
  config,
  secrets,
  sprites,
  log,
  nudgeDeliveries,
  watchMs,
}: Deps) {
  let bundle: Promise<{ bytes: Buffer; sha256: string }> | undefined;
  // read once, again only after a failed read: the bundle ships with this build of the API
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

  async function ensureBundle(spriteName: string, runId: RunId): Promise<void> {
    const { bytes, sha256 } = await loadBundle();
    const current = await execInSprite(sprites, spriteName, [
      "sha256sum",
      RUNNER,
    ]);
    const onSprite = current.exitCode === 0 ? current.stdout.split(" ")[0] : "";
    if (onSprite === sha256) return;
    // a rename is atomic, so a concurrent launch's node reads the old bundle or the new, never half
    // of one; the temp path is per run, so two uploads never write the same file
    const staged = `${RUNNER}.${runId}`;
    await writeSpriteFile(sprites, spriteName, staged, bytes);
    const moved = await execInSprite(sprites, spriteName, [
      "mv",
      "-f",
      staged,
      RUNNER,
    ]);
    if (moved.exitCode !== 0) {
      throw new Error(
        `installing the runner bundle failed: ${moved.stderr.trim()}`,
      );
    }
  }

  async function run(launch: Launch, agentToken: string): Promise<void> {
    await ensureBundle(launch.spriteName, launch.runId);
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
    const key = config.secretEncryptionKey;
    const envSecrets = openEnvSecrets(db, key, launch.envId);
    const envVars = openRunEnvVars(db, key, launch.runId);
    db.update(runs)
      .set({
        secretNames: [
          ...new Set([...envSecrets.keys(), ...envVars.keys()]),
        ].sort(),
      })
      .where(eq(runs.id, launch.runId))
      .run();
    const envFilePath = `/workspace/runs/${launch.runId}.env`;
    await writeSpriteFile(
      sprites,
      launch.spriteName,
      envFilePath,
      envFile([
        ...envSecrets,
        ...envVars,
        ["CLAUDE_CODE_OAUTH_TOKEN", config.claudeOauthToken],
        ["AGENT_TOKEN", agentToken],
      ]),
      { mode: 0o600 },
    );
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
          ENV_FILE: envFilePath,
          PROMPT_FILE: promptFile,
          REPO_DIR,
          WORKTREES_DIR,
          APPROVAL_POLICY: JSON.stringify(launch.approvalPolicy),
          WAIT_TIMEOUT_MINUTES: String(config.waitTimeoutMs / 60_000),
          ...(launch.sessionId ? { SESSION_ID: launch.sessionId } : {}),
        },
        watchMs,
      },
    ).catch(async (err: unknown) => {
      // the runner never started, so nothing else deletes the file its secrets sit in
      await execInSprite(sprites, launch.spriteName, [
        "rm",
        "-f",
        envFilePath,
      ]).catch(() => {});
      throw err;
    });
  }

  /**
   * A launch the Sprites API answers 404 may mean the sprite is gone (an org move, a manual
   * delete). When a lookup confirms it, a ready environment becomes failed at `create`, so
   * `POST /environments/:id/retry` recreates the sprite.
   */
  async function failEnvIfSpriteGone(
    launch: Launch,
    err: unknown,
  ): Promise<void> {
    if (!(err instanceof APIError && err.statusCode === 404)) return;
    if (await spriteExists(sprites, launch.spriteName)) return;
    const marked = db
      .update(environments)
      .set({
        status: "failed",
        failureStep: "create",
        failureStderr: `sprite ${launch.spriteName} no longer exists; retry the environment to recreate it`,
      })
      .where(
        and(
          eq(environments.id, launch.envId),
          eq(environments.status, "ready"),
        ),
      )
      .run();
    if (marked.changes > 0) {
      log(`sprite ${launch.spriteName} is gone; ${launch.envId} marked failed`);
    }
  }

  return {
    start(launch: Launch): void {
      const agentToken = mintAgentToken(config.apiKey, launch.runId);
      run(launch, agentToken)
        .catch(async (err: unknown) => {
          await failEnvIfSpriteGone(launch, err).catch((checkErr: unknown) => {
            log(`checking the sprite of ${launch.envId} failed: ${checkErr}`);
          });
          throw err;
        })
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
          nudgeDeliveries();
        })
        .catch((err: unknown) => {
          log(`launching ${launch.runId} could not record its outcome: ${err}`);
        });
    },
  };
}

export type Launcher = ReturnType<typeof createLauncher>;
