import { expect, test } from "vitest";
import { AgentId, EnvironmentId } from "./ids.js";

test("accepts an id carrying its own prefix", () => {
  expect(AgentId.parse("agt_01JBX3K9Q2")).toBe("agt_01JBX3K9Q2");
});

test("rejects another entity's prefix, a bare prefix and stray characters", () => {
  expect(AgentId.safeParse("env_01JBX3K9Q2").success).toBe(false);
  expect(EnvironmentId.safeParse("env_").success).toBe(false);
  expect(EnvironmentId.safeParse("env_a/../b").success).toBe(false);
});
