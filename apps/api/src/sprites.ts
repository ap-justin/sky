import { createHash } from "node:crypto";
import { APIError, ExecError, type SpritesClient } from "@fly/sprites";

/**
 * The one sprite an environment owns. Hashed because the API rejects names outside lowercase
 * letters, digits and hyphens, and env ids carry uppercase and an underscore.
 */
export const spriteNameFor = (envId: string) =>
  `sky-${createHash("sha256").update(envId).digest("hex").slice(0, 24)}`;

/** Creates the sprite unless it exists, so a rerun after any interruption starts from one. */
export async function ensureSprite(
  client: SpritesClient,
  name: string,
): Promise<void> {
  try {
    await client.getSprite(name);
  } catch (err) {
    if (!(err instanceof APIError && err.statusCode === 404)) throw err;
    await client.createSprite(name);
  }
}

export type ExecOutcome = { exitCode: number; stdout: string; stderr: string };

/**
 * Runs `argv` in the sprite over the SDK's HTTP exec (no WebSocket, no TTY) and waits for it to
 * exit. A nonzero exit resolves with its outcome; only transport and API errors throw.
 */
export async function execInSprite(
  client: SpritesClient,
  name: string,
  [file, ...args]: [string, ...string[]],
  options: { cwd?: string } = {},
): Promise<ExecOutcome> {
  try {
    const result = await client.sprite(name).execFileHTTP(file, args, options);
    return toOutcome(result);
  } catch (err) {
    if (err instanceof ExecError) return toOutcome(err.result);
    throw err;
  }
}

const toOutcome = (r: ExecError["result"]): ExecOutcome => ({
  exitCode: r.exitCode,
  stdout: r.stdout.toString(),
  stderr: r.stderr.toString(),
});

// $1 the log, $2 the tail's byte count, the rest the argv; only a failure writes `<log>.tail`
export const LOGGED_EXEC =
  'log=$1; bytes=$2; shift 2; "$@" >"$log" 2>&1 || { rc=$?; tail -c "$bytes" "$log" >"$log.tail"; exit $rc; }';

/**
 * Runs `argv` like `execInSprite`, but with its stdout and stderr together in `log` in the sprite,
 * so nothing but the exit frame crosses the HTTP exec: its frames carry no length, and output an
 * intermediary re-chunks is misread or rejected. On a nonzero exit, `tail` is the log's last
 * `tailBytes` bytes, read back over the filesystem API; empty when that read fails.
 */
export async function execLogged(
  client: SpritesClient,
  name: string,
  argv: [string, ...string[]],
  options: { cwd?: string; log: string; tailBytes: number },
): Promise<{ exitCode: number; tail: string }> {
  const { exitCode } = await execInSprite(
    client,
    name,
    [
      "sh",
      "-c",
      LOGGED_EXEC,
      "sh",
      options.log,
      `${options.tailBytes}`,
      ...argv,
    ],
    { cwd: options.cwd },
  );
  if (exitCode === 0) return { exitCode, tail: "" };
  const tail = await client
    .sprite(name)
    .filesystem("/")
    .readFile(`${options.log}.tail`, "utf8")
    .catch(() => "");
  return { exitCode, tail };
}

// the API names the new checkpoint only in the `complete` message's text
const CREATED = /^Checkpoint (\S+) created/;

/** Checkpoints the sprite and resolves with the new checkpoint's id. */
export async function checkpointSprite(
  client: SpritesClient,
  name: string,
  comment?: string,
): Promise<string> {
  const stream = await client.sprite(name).createCheckpoint(comment);
  let id: string | undefined;
  for await (const message of stream) {
    if (message.type === "error") {
      throw new Error(message.error ?? "checkpoint failed");
    }
    if (message.type === "complete") id = CREATED.exec(message.data ?? "")?.[1];
  }
  if (!id) throw new Error("checkpoint completed without naming its id");
  return id;
}

/** Destroys the sprite; one already gone counts as destroyed. */
export async function destroySprite(
  client: SpritesClient,
  name: string,
): Promise<void> {
  try {
    await client.deleteSprite(name);
  } catch (err) {
    if (err instanceof APIError && err.statusCode === 404) return;
    throw err;
  }
}

/** Writes `data` to an absolute path in the sprite, creating parent directories. */
export async function writeSpriteFile(
  client: SpritesClient,
  name: string,
  path: string,
  data: string | Buffer,
  options: { mode?: number } = {},
): Promise<void> {
  await client.sprite(name).filesystem("/").writeFile(path, data, options);
}

// past any run: the runner holds the sprite itself and exits on its own; the server default is undocumented
const RUN_AFTER_DISCONNECT = "24h";
const OUTPUT_TAIL = 2000;

/**
 * Starts `argv` in a detachable session, stays attached for `watchMs`, then disconnects: the process
 * keeps running in the sprite with nothing held open to it. A plain exec's process is reaped when
 * its connection drops, so this is the one way to leave a process running. Rejects when the process
 * exits nonzero inside the window, with its exit code and output tail. A TTY merges stderr into
 * that output, and the SDK reads its exit code from the socket's close, so it is only ever 0 or 1.
 */
export function startDetached(
  client: SpritesClient,
  name: string,
  [file, ...args]: [string, ...string[]],
  options: { cwd: string; env: Record<string, string>; watchMs: number },
): Promise<void> {
  const session = client.sprite(name).createSession(file, args, {
    cwd: options.cwd,
    env: options.env,
    maxRunAfterDisconnect: RUN_AFTER_DISCONNECT,
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let watch: NodeJS.Timeout | undefined;
    let output = "";
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(watch);
      session.close();
      if (err) reject(err);
      else resolve();
    };
    session.stdout.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL);
    });
    session.once("spawn", () => {
      watch = setTimeout(() => settle(), options.watchMs);
    });
    session.once("exit", (code: number) => {
      // output pushed to the stream just before 'exit' may not have reached 'data' yet
      setImmediate(() =>
        settle(
          code === 0
            ? undefined
            : new Error(`runner exited ${code} at launch: ${output.trim()}`),
        ),
      );
    });
    // `on`, not `once`: an 'error' emitted after the first, with no listener, would crash the process
    session.on("error", (err: Error) => settle(err));
  });
}
