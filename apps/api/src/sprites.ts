import { APIError, ExecError, type SpritesClient } from "@fly/sprites";

/** The one sprite an environment owns. */
export const spriteNameFor = (envId: string) => `harness-${envId}`;

export async function createSprite(
  client: SpritesClient,
  name: string,
): Promise<void> {
  await client.createSprite(name);
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
