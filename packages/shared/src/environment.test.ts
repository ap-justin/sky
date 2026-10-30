import { expect, test } from "vitest";
import { Environment } from "./environment.js";

const env = {
  id: "env_1",
  name: "kru",
  repo: "ap-justin/kru",
  setup: "pnpm install",
  status: "ready",
  spriteName: "sky-kru",
  checkpointId: "cp_abc",
};

test("accepts an environment and defaults its cap and approval policy", () => {
  expect(Environment.parse(env)).toEqual({
    ...env,
    concurrency: 3,
    approvalPolicy: [],
  });
});

test("keeps an explicit cap and approval policy", () => {
  const parsed = Environment.parse({
    ...env,
    concurrency: 5,
    approvalPolicy: ["Bash", "mcp__github__*"],
  });
  expect(parsed.concurrency).toBe(5);
  expect(parsed.approvalPolicy).toEqual(["Bash", "mcp__github__*"]);
});

test("defaulted approval policies are not one shared array", () => {
  const a = Environment.parse(env);
  a.approvalPolicy.push("Bash");
  expect(Environment.parse(env).approvalPolicy).toEqual([]);
});

test("rejects a malformed repo, a zero cap and an unknown status", () => {
  expect(
    Environment.safeParse({ ...env, repo: "https://github.com/a/b; rm -rf /" })
      .success,
  ).toBe(false);
  expect(Environment.safeParse({ ...env, concurrency: 0 }).success).toBe(false);
  expect(Environment.safeParse({ ...env, status: "booting" }).success).toBe(
    false,
  );
});

test("a provisioning environment has no checkpoint yet", () => {
  expect(
    Environment.parse({ ...env, status: "provisioning", checkpointId: null })
      .checkpointId,
  ).toBeNull();
});
