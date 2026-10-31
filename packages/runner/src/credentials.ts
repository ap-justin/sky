import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The entries already in the credential file, or none when it is missing or not a JSON object. */
async function readExisting(path: string): Promise<Record<string, unknown>> {
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Claude Code removes `CLAUDE_CODE_OAUTH_TOKEN` from the env of the commands it runs, so a nested
 * `claude -p` (the Kru checks) finds no login there. It does read the credential file in its config
 * dir, so the runner writes the same subscription token there, readable by this user only. The
 * entry carries no refresh token and no expiry: the token is a long-lived one from `claude setup-token`.
 *
 * Only `claudeAiOauth` is replaced. Other entries, such as a `designOauth` credential from an
 * interactive `/design-login` on the sprite, are kept, because Claude Code refreshes and rewrites
 * them in place and a run must not sign them out.
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
  const existing = await readExisting(path);
  await writeFile(
    path,
    JSON.stringify({
      ...existing,
      claudeAiOauth: {
        accessToken: token,
        refreshToken: null,
        expiresAt: null,
        scopes: ["user:inference"],
      },
    }),
    { mode: 0o600 },
  );
  // the mode above applies only when the file is created
  await chmod(path, 0o600);
  return path;
}
