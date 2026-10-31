import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

const fresh = {
  accessToken: "oauth-secret-token",
  refreshToken: null,
  expiresAt: null,
  scopes: ["user:inference"],
};
const design = {
  accessToken: "design-access",
  refreshToken: "design-refresh",
};

/** Seeds `<dir>/.credentials.json` and returns its path. */
function seed(dir: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ".credentials.json");
  writeFileSync(path, content);
  return path;
}

test("keeps the other entries when writing the token", async () => {
  const path = seed(
    join(home, ".claude"),
    JSON.stringify({ designOauth: design }),
  );
  await writeClaudeCredentials(
    { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret-token" },
    home,
  );
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    designOauth: design,
    claudeAiOauth: fresh,
  });
});

test("replaces the whole subscription entry, dropping stale fields", async () => {
  const path = seed(
    join(home, ".claude"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "stale",
        refreshToken: "stale-refresh",
        expiresAt: 1,
        organizationUuid: "stale-org",
      },
    }),
  );
  await writeClaudeCredentials(
    { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret-token" },
    home,
  );
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    claudeAiOauth: fresh,
  });
});

test("tightens an existing file that others could read to 0600", async () => {
  const path = seed(join(home, ".claude"), "{}");
  chmodSync(path, 0o644);
  await writeClaudeCredentials(
    { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret-token" },
    home,
  );
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("keeps the other entries in the file under CLAUDE_CONFIG_DIR", async () => {
  const dir = join(home, "cfg");
  const path = seed(dir, JSON.stringify({ designOauth: design }));
  await writeClaudeCredentials(
    { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret-token", CLAUDE_CONFIG_DIR: dir },
    home,
  );
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    designOauth: design,
    claudeAiOauth: fresh,
  });
  expect(existsSync(join(home, ".claude"))).toBe(false);
});

test.each([
  ["not JSON", "not json"],
  ["an array", "[1,2]"],
  ["a string", '"abc"'],
])("starts over when the existing file is %s", async (_, content) => {
  const path = seed(join(home, ".claude"), content);
  await writeClaudeCredentials(
    { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret-token" },
    home,
  );
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    claudeAiOauth: fresh,
  });
});

test("refuses to replace a credential path it cannot read", async () => {
  const path = join(home, ".claude", ".credentials.json");
  mkdirSync(path, { recursive: true });
  await expect(
    writeClaudeCredentials(
      { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret-token" },
      home,
    ),
  ).rejects.toThrow(/EISDIR/);
  expect(statSync(path).isDirectory()).toBe(true);
});

test("leaves no temp file beside the credentials", async () => {
  await writeClaudeCredentials(
    { CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret-token" },
    home,
  );
  expect(readdirSync(join(home, ".claude"))).toEqual([".credentials.json"]);
});
