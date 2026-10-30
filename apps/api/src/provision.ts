import type { SpritesClient } from "@fly/sprites";
import { type Db, type environmentFailureSteps, environments } from "@sky/db";
import type { EnvironmentId } from "@sky/shared";
import { eq, sql } from "drizzle-orm";
import { type KnownSecrets, redact } from "./redact.js";
import { cloneUrl } from "./remote.js";
import type { BundleInstaller } from "./runner-bundle.js";
import { hasConnectorSecret, openEnvSecrets } from "./secrets.js";
import {
  checkpointSprite,
  ensureSprite,
  execInSprite,
  execLogged,
  spriteNameFor,
  writeSpriteFile,
} from "./sprites.js";

export const REPO_DIR = "/workspace/repo";
// the runner's worktrees point at the clone, so they go when it does
export const WORKTREES_DIR = "/workspace/worktrees";
export const RUNNER_DIR = "/opt/sky";
export const RUNNER = `${RUNNER_DIR}/runner.mjs`;
/** The Kru store every agent's session syncs with; the runner reads it from `KRU_STORE_REPO`. */
export const KRU_STORE_REPO = "ap-justin/kru-store";
// = the version in packages/runner/package.json; the runner bundle leaves the SDK external
const RUNNER_SDK = "@anthropic-ai/claude-agent-sdk@0.3.312";
// no --omit=optional: the SDK ships the Claude Code binary as a platform-specific optional dep
const installRunnerSdk = `[ -w ${RUNNER_DIR} ] || sudo install -d -o "$(id -u)" -g "$(id -g)" ${RUNNER_DIR}; npm install --prefix ${RUNNER_DIR} --no-audit --no-fund ${RUNNER_SDK}`;
/**
 * Installs, for the sprite's user, the plugins the clone's `.claude/settings.json` enables, after
 * adding the `extraKnownMarketplaces` entries they come from. A headless session honors
 * `enabledPlugins` only for a plugin already installed; it never fetches one. Runs as `node -e` in
 * the clone with the runner dir as its argument, so it uses the `claude` the SDK bundles.
 * `$HOME/.claude` outlives reprovisioning and a repeat add or install fetches nothing, so every
 * run refreshes the marketplaces and updates each plugin.
 */
const INSTALL_PLUGINS = `
const { execFileSync } = require("node:child_process");
const { existsSync, readdirSync, readFileSync } = require("node:fs");
const file = ".claude/settings.json";
const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const enabled = settings.enabledPlugins ?? {};
const plugins = Object.keys(enabled).filter((p) => enabled[p] === true);
if (plugins.length === 0) process.exit(0);
const sdk = process.argv[1] + "/node_modules/@anthropic-ai";
const platform = readdirSync(sdk).find(
  (d) => d.startsWith("claude-agent-sdk-") && existsSync(sdk + "/" + d + "/claude"),
);
if (!platform) throw new Error("no claude binary under " + sdk);
const claude = (...args) => {
  try {
    execFileSync(sdk + "/" + platform + "/claude", args, { stdio: "inherit" });
  } catch (err) {
    process.exit(err.status || 1);
  }
};
const fail = (name, why) => {
  console.error('marketplace "' + name + '" in ' + file + ": " + why);
  process.exit(1);
};
// the url forms marketplace add clones; any other http(s) url it fetches as a marketplace.json
const addClones = (url) =>
  /^[^/@:]+@[^/:]+:/.test(url) ||
  (/^https?:/.test(url) && URL.canParse(url) &&
    (url.endsWith(".git") || url.includes("/_git/") || ["github.com", "gitlab.com"].includes(new URL(url).hostname)));
// marketplace add takes one source string, so a field that string can't carry is refused, not dropped
const addArgs = (name, source) => {
  if (typeof source?.source !== "string") fail(name, "no source object");
  const { source: type, repo, url, path, ref, sparsePaths } = source;
  const pinned = (where) => (ref ? where + "#" + ref : where);
  const sparse = sparsePaths?.length ? ["--sparse", ...sparsePaths] : [];
  if ((type === "github" || type === "git") && path) fail(name, "marketplace add can't read a " + type + " source's path");
  if (type === "github") return [pinned(repo), ...sparse];
  if (type === "git") {
    if (typeof url !== "string" || !addClones(url)) fail(name, url + " isn't a url marketplace add clones; end it in .git");
    return [pinned(url), ...sparse];
  }
  if (type === "url") {
    if (source.headers || source.headersHelper) fail(name, "marketplace add can't send a url source's headers");
    return [url];
  }
  if (type === "directory" || type === "file") return [path];
  fail(name, "unsupported source: " + type);
};
const used = new Set(plugins.map((p) => p.slice(p.lastIndexOf("@") + 1)));
const adds = Object.entries(settings.extraKnownMarketplaces ?? {})
  .filter(([name]) => used.has(name))
  .map(([name, entry]) => addArgs(name, entry?.source));
for (const args of adds) claude("plugin", "marketplace", "add", ...args);
claude("plugin", "marketplace", "update");
for (const plugin of plugins) claude("plugin", "install", plugin, "--scope", "user");
for (const plugin of plugins) claude("plugin", "update", plugin, "--scope", "user");
`;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** `export NAME='value'` lines for sh to source; later names override earlier ones. */
export const envFile = (vars: Iterable<readonly [string, string]>) =>
  [...vars]
    .map(([name, value]) => `export ${name}=${shellQuote(value)}\n`)
    .join("");

// the store steps' env, as a run's, rides in a file: an exec's argv and env reach the sprite as URL
// query params
const STORE_ENV_FILE = "/tmp/sky-kru-store.env";
const PULL_STORE = `. "$1" && exec node ${RUNNER} store-sync pull`;
// the store's root as Kru resolves it under the env a run has (its plugin is installed by now),
// then the store's own setup script when it has one; the root falls back to Kru's default when the
// plugin is missing. Only the root resolution sees the env file
const RUN_STORE_SETUP = `home=$(. "$1" || exit 1; h=$(bash "$HOME/.claude/plugins/marketplaces/kru/scripts/kru-store.sh" home 2>/dev/null); printf %s "\${h:-\${KRU_HOME:-$HOME/.kru}}") || exit 1; if [ -f "$home/setup.sh" ]; then bash "$home/setup.sh"; fi`;
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
  secretEncryptionKey: Buffer;
  secrets: KnownSecrets;
  sprites: SpritesClient;
  ensureBundle: BundleInstaller;
  log: (line: string) => void;
};
type Target = { id: EnvironmentId; repo: string; setup: string };

/**
 * Runs provisioning as in-process background jobs. A failure lands in `failure_step` and
 * `failure_stderr`: the failed command's output tail (stdout and stderr together), or the Sprites
 * error for create/checkpoint.
 */
export function createProvisioner({
  db,
  secretEncryptionKey,
  secrets,
  sprites,
  ensureBundle,
  log,
}: Deps) {
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
    /**
     * The sprite reaches GitHub only through its connector, which carries REST and no git
     * transport, so the Kru store (private) is checked out by the runner's `store-sync pull`, then
     * the store's own `setup.sh` runs, as the cloud setup script does after its clone. `~/.kru`
     * outlives reprovisioning and a pull merges what is there, so this is safe to repeat. Without
     * a connector secret there is nothing to reach GitHub with. A failure is logged and never
     * fails provisioning: each run's own pull tries again.
     */
    const checkoutKruStore = async (
      envId: EnvironmentId,
      sprite: string,
    ): Promise<void> => {
      let stored = new Map<string, string>();
      try {
        if (!hasConnectorSecret(db, envId, "GITHUB_CONNECTOR")) return;
        stored = openEnvSecrets(db, secretEncryptionKey, envId);
        // the runner's own off switch, which it reads from the same env on every run
        if (stored.get("KRU_NO_STORE_SYNC")) return;
        await ensureBundle(sprite, `provision-${envId}`);
        await writeSpriteFile(
          sprites,
          sprite,
          STORE_ENV_FILE,
          envFile([...stored, ["KRU_STORE_REPO", KRU_STORE_REPO]]),
          { mode: 0o600 },
        );
        try {
          await execNoisy(
            ["sh", "-c", PULL_STORE, "sh", STORE_ENV_FILE],
            "/tmp/sky-kru-store.log",
          );
          await execNoisy(
            ["bash", "-c", RUN_STORE_SETUP, "bash", STORE_ENV_FILE],
            "/tmp/sky-kru-setup.log",
          );
        } finally {
          // the checkpoint must not keep the env's secrets
          await execInSprite(sprites, sprite, ["rm", "-f", STORE_ENV_FILE]);
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log(
          `checking out the Kru store in ${sprite} failed: ${redact(detail, [...secrets.values(), ...stored.values()])}`,
        );
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
        ["node", "-e", INSTALL_PLUGINS, RUNNER_DIR],
        "/tmp/sky-plugins.log",
        REPO_DIR,
      );
      await execNoisy(
        ["sh", "-c", PREPARE_SETUP, "sh", "bash", "-c", env.setup],
        "/tmp/sky-setup.log",
        REPO_DIR,
      );
      await checkoutKruStore(env.id, name);
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
