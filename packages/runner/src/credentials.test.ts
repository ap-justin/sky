import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

test("replaces only the subscription entry and keeps the others, private to the user", async () => {
  const dir = join(home, ".claude");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ".credentials.json");
  const design = {
    accessToken: "design-access",
    refreshToken: "design-refresh",
  };
  writeFileSync(
    path,
    JSON.stringify({
      claudeAiOauth: { accessToken: "stale" },
      designOauth: design,
    }),
    { mode: 0o644 },
  );
  await writeClaudeCredentials(
    { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret-token" },
    home,
  );
  const written = JSON.parse(readFileSync(path, "utf8"));
  expect(written.designOauth).toEqual(design);
  expect(written.claudeAiOauth.accessToken).toBe("oauth-secret-token");
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("starts over when the existing file is not a JSON object", async () => {
  const dir = join(home, ".claude");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ".credentials.json");
  writeFileSync(path, "not json");
  await writeClaudeCredentials(
    { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret-token" },
    home,
  );
  expect(Object.keys(JSON.parse(readFileSync(path, "utf8")))).toEqual([
    "claudeAiOauth",
  ]);
});
