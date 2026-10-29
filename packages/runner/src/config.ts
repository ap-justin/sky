import { AgentId, RunId } from "@harness/shared";
import { z } from "zod";

const Env = z.object({
  AGENT_ID: AgentId,
  RUN_ID: RunId,
  PROMPT: z.string().min(1),
  SESSION_ID: z
    .string()
    .optional()
    .transform((s) => s || undefined),
  API_BASE_URL: z.url(),
  AGENT_TOKEN: z.string().min(1),
  // presence only: the Claude subprocess reads it from the inherited env, so it never enters Config
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1),
  REPO_DIR: z.string().min(1).default("/workspace/repo"),
  WORKTREES_DIR: z.string().min(1).default("/workspace/worktrees"),
});

export type Config = {
  agentId: AgentId;
  runId: RunId;
  prompt: string;
  sessionId: string | undefined;
  apiBaseUrl: string;
  agentToken: string;
  repoDir: string;
  worktreesDir: string;
};

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    // keys only: issue messages can quote the received value, and two of these are secrets
    const keys = [
      ...new Set(parsed.error.issues.map((i) => String(i.path[0]))),
    ];
    throw new ConfigError(`missing or invalid env: ${keys.join(", ")}`);
  }
  const e = parsed.data;
  return {
    agentId: e.AGENT_ID,
    runId: e.RUN_ID,
    prompt: e.PROMPT,
    sessionId: e.SESSION_ID,
    apiBaseUrl: e.API_BASE_URL,
    agentToken: e.AGENT_TOKEN,
    repoDir: e.REPO_DIR,
    worktreesDir: e.WORKTREES_DIR,
  };
}
