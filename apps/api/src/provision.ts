import type { SpritesClient } from "@fly/sprites";
import {
  type Db,
  type environmentFailureSteps,
  environments,
} from "@harness/db";
import type { EnvironmentId } from "@harness/shared";
import { eq } from "drizzle-orm";
import { type KnownSecrets, redact } from "./redact.js";
import { cloneUrl } from "./remote.js";
import {
  checkpointSprite,
  createSprite,
  execInSprite,
  spriteNameFor,
} from "./sprites.js";

export const REPO_DIR = "/workspace/repo";
// the runner's worktrees point at the clone, so they go when it does
export const WORKTREES_DIR = "/workspace/worktrees";
export const RUNNER_DIR = "/opt/harness";
// = the version in packages/runner/package.json; the runner bundle leaves the SDK external
const RUNNER_SDK = "@anthropic-ai/claude-agent-sdk@0.3.312";
// no --omit=optional: the SDK ships the Claude Code binary as a platform-specific optional dep
const installRunnerSdk = `[ -w ${RUNNER_DIR} ] || sudo install -d -o "$(id -u)" -g "$(id -g)" ${RUNNER_DIR}; npm install --prefix ${RUNNER_DIR} --no-audit --no-fund ${RUNNER_SDK}`;
// ≤ the length CHECK on environments.failure_stderr in db/src/schema.ts
const TAIL_CHARS = 4000;

class StepFailed extends Error {}

type Deps = {
  db: Db;
  secrets: KnownSecrets;
  sprites: SpritesClient;
  log: (line: string) => void;
};
type Target = { id: EnvironmentId; repo: string; setup: string };

/**
 * Runs provisioning as in-process background jobs. A failure lands in `failure_step` and
 * `failure_stderr`: the failed command's stderr tail, or the Sprites error for create/checkpoint.
 */
export function createProvisioner({ db, secrets, sprites, log }: Deps) {
  async function run(env: Target, fresh: boolean): Promise<void> {
    const name = spriteNameFor(env.id);
    const exec = async (argv: [string, ...string[]], cwd?: string) => {
      const out = await execInSprite(sprites, name, argv, { cwd });
      if (out.exitCode !== 0) {
        throw new StepFailed(out.stderr || `exited with code ${out.exitCode}`);
      }
    };
    let step: (typeof environmentFailureSteps)[number] = "create";
    try {
      if (fresh) await createSprite(sprites, name);
      step = "clone";
      await exec(["rm", "-rf", REPO_DIR, WORKTREES_DIR]);
      await exec(["git", "clone", cloneUrl(env.repo), REPO_DIR]);
      step = "setup";
      await exec(["sh", "-c", installRunnerSdk]);
      await exec(["bash", "-c", env.setup], REPO_DIR);
      step = "checkpoint";
      const checkpointId = await checkpointSprite(
        sprites,
        name,
        "harness setup",
      );
      db.update(environments)
        .set({ status: "ready", checkpointId })
        .where(eq(environments.id, env.id))
        .run();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      db.update(environments)
        .set({
          status: "failed",
          failureStep: step,
          failureStderr: redact(detail, secrets.values()).slice(-TAIL_CHARS),
        })
        .where(eq(environments.id, env.id))
        .run();
    }
  }

  return {
    /** Starts provisioning without waiting; `fresh` creates the sprite first. The caller clears any previous failure. */
    start(env: Target, { fresh }: { fresh: boolean }): void {
      run(env, fresh).catch((err: unknown) => {
        log(`provisioning ${env.id} could not record its outcome: ${err}`);
      });
    },
  };
}

export type Provisioner = ReturnType<typeof createProvisioner>;

/** Provisioning jobs die with the process; call at boot so none stays `provisioning` forever. */
export function failInterruptedProvisioning(db: Db): void {
  db.update(environments)
    .set({ status: "failed" })
    .where(eq(environments.status, "provisioning"))
    .run();
}
