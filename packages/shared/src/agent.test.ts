import { expect, test } from "vitest";
import { Agent, agentBranch } from "./agent.js";

const agent = {
  id: "agt_7",
  envId: "env_1",
  sessionId: null,
  branch: "claude/agt_7",
  status: "idle",
  archivedAt: null,
};

test("accepts an agent on its own branch", () => {
  expect(Agent.parse(agent)).toEqual(agent);
  expect(
    Agent.parse({ ...agent, sessionId: "8f2c-session", status: "running" })
      .sessionId,
  ).toBe("8f2c-session");
});

test("agentBranch names the agent's branch", () => {
  expect(agentBranch("agt_7")).toBe("claude/agt_7");
});

test("rejects a branch that isn't claude/<agentId>", () => {
  const result = Agent.safeParse({ ...agent, branch: "claude/agt_8" });
  expect(result.success).toBe(false);
  expect(result.error?.issues[0]?.path).toEqual(["branch"]);
  expect(Agent.safeParse({ ...agent, branch: "main" }).success).toBe(false);
});

test("archivedAt is null or a UTC ISO timestamp", () => {
  const archivedAt = "2026-10-29T12:00:00.000Z";
  expect(Agent.parse({ ...agent, archivedAt }).archivedAt).toBe(archivedAt);
  expect(Agent.safeParse({ ...agent, archivedAt: "yesterday" }).success).toBe(
    false,
  );
  const { archivedAt: _, ...unarchived } = agent;
  expect(Agent.safeParse(unarchived).success).toBe(false);
});
