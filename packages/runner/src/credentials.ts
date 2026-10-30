import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Claude Code removes `CLAUDE_CODE_OAUTH_TOKEN` from the env of the commands it runs, so a nested
 * `claude -p` (the Kru checks) finds no login there. It does read the credential file in its config
 * dir, so the runner writes the same subscription token there, readable by this user only. The
 * file carries no refresh token and no expiry: the token is a long-lived one from `claude setup-token`.
 */
export async function writeClaudeCredentials(
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): Promise<string> {
  const token = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) throw new Error("CLAUDE_CODE_OAUTH_TOKEN is not set");
  const dir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const path = join(dir, ".credentials.json");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: token,
        refreshToken: null,
        expiresAt: null,
        scopes: ["user:inference"],
      },
    }),
    { mode: 0o600 },
  );
  return path;
}
