import type { SpritesClient } from "@fly/sprites";
import { type Db, type environmentFailureSteps, environments } from "@sky/db";
import type { EnvironmentId } from "@sky/shared";
import { eq, sql } from "drizzle-orm";
import { type KnownSecrets, redact } from "./redact.js";
import { cloneUrl } from "./remote.js";
import {
  checkpointSprite,
  ensureSprite,
  execInSprite,
  execLogged,
  spriteNameFor,
} from "./sprites.js";

export const REPO_DIR = "/workspace/repo";
// the runner's worktrees point at the clone, so they go when it does
export const WORKTREES_DIR = "/workspace/worktrees";
export const RUNNER_DIR = "/opt/sky";
// = the version in packages/runner/package.json; the runner bundle leaves the SDK external
const RUNNER_SDK = "@anthropic-ai/claude-agent-sdk@0.3.312";
// no --omit=optional: the SDK ships the Claude Code binary as a platform-specific optional dep
const installRunnerSdk = `[ -w ${RUNNER_DIR} ] || sudo install -d -o "$(id -u)" -g "$(id -g)" ${RUNNER_DIR}; npm install --prefix ${RUNNER_DIR} --no-audit --no-fund ${RUNNER_SDK}`;
// the sprite's node ships corepack but no pnpm or yarn; corepack's shims go under $HOME, so need no
// root, and resolve the repo's `packageManager` version when run
const PACKAGE_MANAGERS_DIR = "$HOME/.local/bin";
/**
 * Puts the shims first on PATH for a non-login shell, which reads no profile. Turns corepack's
 * download prompt off, since with a TTY it can stop to ask before fetching a package manager.
 */
export const WITH_PACKAGE_MANAGERS = `export PATH="${PACKAGE_MANAGERS_DIR}:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0`;
// enables the shims, then execs its argv (the setup); enabling again on a rerun is harmless
const PREPARE_SETUP = `mkdir -p "${PACKAGE_MANAGERS_DIR}" && corepack enable --install-directory "${PACKAGE_MANAGERS_DIR}" && ${WITH_PACKAGE_MANAGERS} && exec "$@"`;
// ≤ the length CHECK on environments.failure_stderr in db/src/schema.ts
const TAIL_CHARS = 4000;

const INTERRUPTED =
  "interrupted: the API restarted during this step; a retry provisions from the start";

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
 * `failure_stderr`: the failed command's output tail (stdout and stderr together), or the Sprites
 * error for create/checkpoint.
 */
export function createProvisioner({ db, secrets, sprites, log }: Deps) {
  async function run(env: Target): Promise<void> {
    const name = spriteNameFor(env.id);
    const exec = async (argv: [string, ...string[]]) => {
      const out = await execInSprite(sprites, name, argv);
      if (out.exitCode !== 0) {
        throw new StepFailed(out.stderr || `exited with code ${out.exitCode}`);
      }
    };
    // clone, install and setup print plenty, so their output stays in a log in the sprite
    const execNoisy = async (
      argv: [string, ...string[]],
      log: string,
      cwd?: string,
    ) => {
      const out = await execLogged(sprites, name, argv, {
        cwd,
        log,
        tailBytes: TAIL_CHARS,
      });
      if (out.exitCode !== 0) {
        throw new StepFailed(out.tail || `exited with code ${out.exitCode}`);
      }
    };
    let step: (typeof environmentFailureSteps)[number] = "create";
    // the step in progress is stored as it starts, so a restart can name where it stopped
    const begin = (next: typeof step) => {
      step = next;
      db.update(environments)
        .set({ failureStep: next })
        .where(eq(environments.id, env.id))
        .run();
    };
    try {
      begin("create");
      await ensureSprite(sprites, name);
      begin("clone");
      await exec(["rm", "-rf", REPO_DIR, WORKTREES_DIR]);
      await execNoisy(
        ["git", "clone", cloneUrl(env.repo), REPO_DIR],
        "/tmp/sky-clone.log",
      );
      begin("setup");
      await execNoisy(["sh", "-c", installRunnerSdk], "/tmp/sky-sdk.log");
      await execNoisy(
        ["sh", "-c", PREPARE_SETUP, "sh", "bash", "-c", env.setup],
        "/tmp/sky-setup.log",
        REPO_DIR,
      );
      begin("checkpoint");
      const checkpointId = await checkpointSprite(sprites, name, "sky setup");
      db.update(environments)
        .set({ status: "ready", checkpointId, failureStep: null })
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
    /** Starts provisioning without waiting. The caller clears any previous failure. */
    start(env: Target): void {
      run(env).catch((err: unknown) => {
        log(`provisioning ${env.id} could not record its outcome: ${err}`);
      });
    },
  };
}

export type Provisioner = ReturnType<typeof createProvisioner>;

/**
 * Provisioning jobs die with the process; call at boot so none stays `provisioning` forever. Each is
 * failed at the step it was in, `create` when it never started one.
 */
export function failInterruptedProvisioning(db: Db): void {
  db.update(environments)
    .set({
      status: "failed",
      failureStep: sql`coalesce(${environments.failureStep}, 'create')`,
      failureStderr: INTERRUPTED,
    })
    .where(eq(environments.status, "provisioning"))
    .run();
}
