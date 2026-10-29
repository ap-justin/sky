import { expect, test } from "vitest";
import { Agent, agentBranch } from "./agent.js";

const agent = {
  id: "agt_7",
  envId: "env_1",
  sessionId: null,
  branch: "claude/agt_7",
  status: "idle",
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
