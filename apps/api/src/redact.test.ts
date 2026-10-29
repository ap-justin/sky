import { expect, test } from "vitest";
import { KnownSecrets, redact, redactDeep } from "./redact.js";

const secrets = {
  apiKey: "k".repeat(40),
  spritesToken: "sprites-tok-123",
  claudeOauthToken: "claude-oauth-opaque-1",
  publicBaseUrl: "https://harness.internal.example",
};
const known = KnownSecrets.fromConfig(secrets).values();

const credentials = [
  ["an Anthropic OAuth token", "sk-ant-oat01-AbCdEf0123456789_xyz-AbCdEf"],
  ["an sk- key", "sk-proj-0123456789abcdefABCDEF"],
  ["a classic GitHub token", `ghp_${"a1B2".repeat(9)}`],
  ["a fine-grained GitHub token", `github_pat_11ABC${"x9".repeat(20)}`],
  [
    "a JWT",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ],
  ["the API key", secrets.apiKey],
  ["the Sprites token", secrets.spritesToken],
  ["the Claude OAuth token", secrets.claudeOauthToken],
  ["the public base URL", secrets.publicBaseUrl],
] as const;

test.each(credentials)("scrubs %s and keeps the text around it", (_, token) => {
  expect(redact(`fatal: auth ${token} rejected`, known)).toBe(
    "fatal: auth [redacted] rejected",
  );
});

test.each(credentials)(
  "scrubs %s from every nested object and array string",
  (_, token) => {
    const payload = {
      request: { kind: "question", prompt: `use ${token}` },
      lines: ["ok", `line two ${token}`, [{ deep: `\n${token}` }]],
      count: 3,
      done: false,
      none: null,
    };
    expect(redactDeep(payload, known)).toEqual({
      request: { kind: "question", prompt: "use [redacted]" },
      lines: ["ok", "line two [redacted]", [{ deep: "\n[redacted]" }]],
      count: 3,
      done: false,
      none: null,
    });
  },
);

test.each([
  ["words containing sk-", "task-list and disk-usage-report"],
  ["an sk- prefix too short for a key", "sk-short123"],
  ["a ghp_ prefix too short for a token", "ghp_abc123"],
  ["a two-segment eyJ string", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0"],
  ["a prefix of a known value", secrets.spritesToken.slice(0, -1)],
])("leaves a near-miss alone: %s", (_, text) => {
  expect(redactDeep({ nested: [text] }, known)).toEqual({ nested: [text] });
});

test("scrubs extra values the caller names, such as a run's agent token", () => {
  expect(redact("token=agent-tok-xyz&x=1", [...known, "agent-tok-xyz"])).toBe(
    "token=[redacted]&x=1",
  );
});

test("values added after boot are scrubbed too", () => {
  const registry = KnownSecrets.fromConfig(secrets);
  registry.add("env DATABASE_URL", "postgres://u:hunter2@db/x");
  expect(redact("connect postgres://u:hunter2@db/x", registry.values())).toBe(
    "connect [redacted]",
  );
});

test("values shorter than 8 characters are never registered", () => {
  const registry = KnownSecrets.fromConfig({ ...secrets, spritesToken: "abc" });
  registry.add("env FLAG", "true");
  expect(registry.values()).not.toContain("abc");
  expect(registry.values()).not.toContain("true");
  expect(redact("abc is true", registry.values())).toBe("abc is true");
});
