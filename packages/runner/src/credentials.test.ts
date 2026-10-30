import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { writeClaudeCredentials } from "./credentials.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "runner-cred-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("writes the subscription token where a nested claude looks, private to the user", async () => {
  const path = await writeClaudeCredentials(
    { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret-token" },
    home,
  );
  expect(path).toBe(join(home, ".claude", ".credentials.json"));
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    claudeAiOauth: {
      accessToken: "oauth-secret-token",
      refreshToken: null,
      expiresAt: null,
      scopes: ["user:inference"],
    },
  });
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("honours CLAUDE_CONFIG_DIR", async () => {
  const dir = join(home, "cfg");
  const path = await writeClaudeCredentials(
    { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret-token", CLAUDE_CONFIG_DIR: dir },
    home,
  );
  expect(path).toBe(join(dir, ".credentials.json"));
});

test("refuses to write without a token, and the error never holds a value", async () => {
  await expect(writeClaudeCredentials({}, home)).rejects.toThrow(
    "CLAUDE_CODE_OAUTH_TOKEN is not set",
  );
});
