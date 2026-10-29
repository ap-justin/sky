import { z } from "zod";
import { AgentId, EnvironmentId } from "./ids.js";

export const AgentStatus = z.enum(["idle", "running", "waiting"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const agentBranch = <Id extends AgentId>(agentId: Id) =>
  `claude/${agentId}` as const;

export const Agent = z
  .object({
    id: AgentId,
    envId: EnvironmentId,
    /** Claude session id; null until the agent's first run starts a session. */
    sessionId: z.string().min(1).nullable(),
    branch: z.templateLiteral(["claude/", AgentId]),
    status: AgentStatus,
    /** When the agent was archived; an archived agent takes no more runs. */
    archivedAt: z.iso.datetime().nullable(),
  })
  .refine((agent) => agent.branch === agentBranch(agent.id), {
    path: ["branch"],
    message: "branch must be claude/<agentId>",
  });
export type Agent = z.infer<typeof Agent>;
