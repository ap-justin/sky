import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SpritesClient } from "@fly/sprites";
import type { Db } from "@harness/db";
import type { AgentId, RunId } from "@harness/shared";
import { mintAgentToken } from "./agent-token.js";
import type { Config } from "./config.js";
import { REPO_DIR, RUNNER_DIR, WORKTREES_DIR } from "./provision.js";
import { redact } from "./redact.js";
import { failRun } from "./runs.js";
import { execInSprite, startDetached, writeSpriteFile } from "./sprites.js";

const RUNNER = `${RUNNER_DIR}/runner.mjs`;
// the prompt rides in a file: env reaches the session as URL query params, too short for a long prompt
const RUNNER_COMMAND = `PROMPT="$(cat "$PROMPT_FILE")" && export PROMPT && exec node ${RUNNER}`;

type Deps = {
  db: Db;
  config: Config;
  sprites: SpritesClient;
  log: (line: string) => void;
};
export type Launch = {
  spriteName: string;
  agentId: AgentId;
  runId: RunId;
  prompt: string;
};

/** Starts runners in the background; a launch that fails fails its run with a redacted `launch_failed` error. */
export function createLauncher({ db, config, sprites, log }: Deps) {
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
            config,
            agentToken,
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
