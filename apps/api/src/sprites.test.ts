import { APIError, SpritesClient } from "@fly/sprites";
import { expect, test } from "vitest";
import { spriteNameFor } from "./sprites.js";
import { spritesToken, stubSprites } from "./testing/sprites.js";

test("names a sprite in the API's lowercase-and-hyphen alphabet, deterministically and per env", () => {
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
