import { expect, test } from "vitest";
import { redact } from "./redact.js";

const secrets = {
  apiKey: "k".repeat(40),
  spritesToken: "sprites-tok-123",
  claudeOauthToken: "claude-oauth-opaque-1",
  publicBaseUrl: "https://harness.internal.example",
};

test.each([
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
])("scrubs %s and keeps the text around it", (_, token) => {
  expect(redact(`fatal: auth ${token} rejected`, secrets)).toBe(
    "fatal: auth [redacted] rejected",
  );
});

test("leaves ordinary words containing sk- alone", () => {
  expect(redact("task-list and disk-usage-report", secrets)).toBe(
    "task-list and disk-usage-report",
  );
});

test("scrubs extra values the caller names, such as a run's agent token", () => {
  expect(redact("token=agent-tok-xyz&x=1", secrets, "agent-tok-xyz")).toBe(
    "token=[redacted]&x=1",
  );
});
