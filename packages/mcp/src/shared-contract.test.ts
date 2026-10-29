import { type Agent, Environment, type RunStatus } from "@harness/shared";
import { expect, expectTypeOf, test } from "vitest";

test("resolves @harness/shared through its package exports", () => {
  expectTypeOf<Agent["branch"]>().toEqualTypeOf<`claude/agt_${string}`>();
  expectTypeOf<"waiting">().toExtend<RunStatus>();
  expect(Environment.shape.concurrency.parse(undefined)).toBe(3);
});
