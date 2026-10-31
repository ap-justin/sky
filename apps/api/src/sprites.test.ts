import { APIError, SpritesClient } from "@fly/sprites";
import { expect, test, vi } from "vitest";
import { KnownSecrets } from "./redact.js";
import {
  execInSprite,
  type SpriteOps,
  SpriteTimeoutError,
  spriteCall,
  spriteNameFor,
} from "./sprites.js";
import { spritesToken, stubSprites } from "./testing/sprites.js";

test("names a sprite in the API's lowercase, digit and hyphen alphabet, deterministically and per env", () => {
  const ids = ["env_q9shK0hzD63HUeS9mmcuHz", "env_Q9shK0hzD63HUeS9mmcuHz", "x"];
  const names = ids.map(spriteNameFor);
  for (const name of names) expect(name).toMatch(/^sky-[0-9a-f]{24}$/);
  expect(names.map((n) => /^[a-z0-9-]+$/.test(n))).toEqual([true, true, true]);
  expect(ids.map(spriteNameFor)).toEqual(names);
  expect(new Set(names).size).toBe(ids.length);
});

test("the stub refuses a name outside the API's alphabet with a 400, on create and get", async () => {
  const wire = stubSprites();
  const client = new SpritesClient(spritesToken);
  const bad = "sky-env_q9shK0hzD63HUeS9mmcuHz";
  for (const call of [
    () => client.createSprite(bad),
    () => client.getSprite(bad),
  ]) {
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).statusCode).toBe(400);
  }
  expect(wire.sprites.has(bad)).toBe(false);
});

const opsWith = (overrides: Partial<SpriteOps> = {}) => {
  const logged: string[] = [];
  const secrets = new KnownSecrets();
  secrets.add("SPRITES_TOKEN", spritesToken);
  const ops: SpriteOps = {
    client: new SpritesClient(spritesToken),
    log: (line) => logged.push(line),
    secrets,
    timeoutMs: 60_000,
    longTimeoutMs: 30 * 60_000,
    ...overrides,
  };
  return { ops, logged };
};

test("a Sprites call logs a start line, then an end line with its op, outcome and duration", async () => {
  const wire = stubSprites();
  wire.sprites.add("sky-a");
  const { ops, logged } = opsWith();
  await execInSprite(ops, "sky-a", ["true"], { op: "wake" });
  wire.exec = () => ({ exitCode: 128 });
  await execInSprite(ops, "sky-a", ["git", "clone"], { op: "clone" });
  expect(logged).toEqual([
    "sprite sky-a wake: start",
    expect.stringMatching(/^sprite sky-a wake: ok in \d+ms$/),
    "sprite sky-a clone: start",
    expect.stringMatching(/^sprite sky-a clone: exited 128 in \d+ms$/),
  ]);
});

test("a failed Sprites call logs failed with its message, scrubbed of known secrets and the caller's values", async () => {
  const { ops, logged } = opsWith();
  const err = await spriteCall(
    ops,
    "sky-a",
    { op: "write-file", known: ["agent-token-value"] },
    async () => {
      throw new Error(`refused ${spritesToken} for agent-token-value`);
    },
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect(logged).toEqual([
    "sprite sky-a write-file: start",
    expect.stringMatching(
      /^sprite sky-a write-file: failed in \d+ms: refused \[redacted\] for \[redacted\]$/,
    ),
  ]);
});

test("a Sprites call that never answers rejects at its bound, naming sprite, op and bound, logs timed out and aborts its signal", async () => {
  const { ops, logged } = opsWith({ timeoutMs: 20 });
  let signal: AbortSignal | undefined;
  const err = await spriteCall(ops, "sky-a", { op: "sha256sum" }, (s) => {
    signal = s;
    return new Promise(() => {});
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SpriteTimeoutError);
  expect((err as Error).message).toBe(
    "sprite sky-a: sha256sum timed out after 20 ms",
  );
  expect(signal?.aborted).toBe(true);
  expect(logged).toEqual([
    "sprite sky-a sha256sum: start",
    "sprite sky-a sha256sum: timed out after 20ms",
  ]);
});

test("a hung exec is cut at its bound: the request is aborted and the call rejects as timed out", async () => {
  const wire = stubSprites();
  wire.sprites.add("sky-a");
  wire.hangs = (call) => call.includes("git clone");
  const { ops, logged } = opsWith();
  const started = Date.now();
  const err = await execInSprite(ops, "sky-a", ["git", "clone", "x"], {
    op: "clone",
    timeoutMs: 50,
  }).catch((e: unknown) => e);
  expect(Date.now() - started).toBeLessThan(2_000);
  expect((err as Error).message).toBe(
    "sprite sky-a: clone timed out after 50 ms",
  );
  expect(logged.at(-1)).toBe("sprite sky-a clone: timed out after 50ms");
});

test("a bound in whole minutes or seconds reads as such in the error", async () => {
  const { ops } = opsWith();
  vi.useFakeTimers();
  try {
    for (const [timeoutMs, words] of [
      [30 * 60_000, "30 min"],
      [90_000, "90 s"],
    ] as const) {
      const call = spriteCall(
        ops,
        "sky-a",
        { op: "clone", timeoutMs },
        () => new Promise(() => {}),
      ).catch((e: unknown) => (e as Error).message);
      await vi.advanceTimersByTimeAsync(timeoutMs);
      expect(await call).toBe(`sprite sky-a: clone timed out after ${words}`);
    }
  } finally {
    vi.useRealTimers();
  }
});
