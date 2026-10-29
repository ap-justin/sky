import type { SpritesClient } from "@fly/sprites";
import { type Db, environments } from "@harness/db";
import type { EnvironmentId } from "@harness/shared";
import { eq } from "drizzle-orm";
import type { Config } from "./config.js";
import { redact } from "./redact.js";
import { cloneUrl } from "./remote.js";
import {
  checkpointSprite,
  createSprite,
  execInSprite,
  spriteNameFor,
} from "./sprites.js";

export const REPO_DIR = "/workspace/repo";
const TAIL_CHARS = 4000;

export type ProvisionStep = "create" | "clone" | "setup" | "checkpoint";
/** `stderr` is the failed command's stderr tail, or the Sprites error for create/checkpoint; always redacted. */
export type ProvisionFailure = { step: ProvisionStep; stderr: string };

class StepFailed extends Error {}

type Deps = {
  db: Db;
  config: Config;
  sprites: SpritesClient;
  log: (line: string) => void;
};
type Target = { id: EnvironmentId; repo: string; setup: string };

/**
 * Runs provisioning as in-process background jobs. Failures live in memory only (the table has no
 * column for them), so a failure recorded before a restart reads as null afterwards.
 */
export function createProvisioner({ db, config, sprites, log }: Deps) {
  const failures = new Map<EnvironmentId, ProvisionFailure>();

  async function run(env: Target, fresh: boolean): Promise<void> {
    const name = spriteNameFor(env.id);
    const exec = async (argv: [string, ...string[]], cwd?: string) => {
      const out = await execInSprite(sprites, name, argv, { cwd });
      if (out.exitCode !== 0) {
        throw new StepFailed(out.stderr || `exited with code ${out.exitCode}`);
      }
    };
    let step: ProvisionStep = "create";
    try {
      if (fresh) await createSprite(sprites, name);
      step = "clone";
      await exec(["rm", "-rf", REPO_DIR]);
      await exec(["git", "clone", cloneUrl(env.repo), REPO_DIR]);
      step = "setup";
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
      failures.set(env.id, {
        step,
        stderr: redact(detail, config).slice(-TAIL_CHARS),
      });
      db.update(environments)
        .set({ status: "failed" })
        .where(eq(environments.id, env.id))
        .run();
    }
  }

  return {
    /** Starts provisioning without waiting; `fresh` creates the sprite first. */
    start(env: Target, { fresh }: { fresh: boolean }): void {
      failures.delete(env.id);
      run(env, fresh).catch((err: unknown) => {
        log(`provisioning ${env.id} could not record its outcome: ${err}`);
      });
    },
    failureOf: (id: EnvironmentId) => failures.get(id) ?? null,
    forget: (id: EnvironmentId) => failures.delete(id),
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
