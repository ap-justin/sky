import { expect, test } from "vitest";
import { loadConfig } from "./config.js";

const apiKey = "k".repeat(40);
const spritesToken = "sprites-token";
const claudeOauthToken = "sk-ant-oat01-test";
const required = {
  SKY_API_KEY: apiKey,
  SPRITES_TOKEN: spritesToken,
  DATA_DIR: "/data",
  CLAUDE_CODE_OAUTH_TOKEN: claudeOauthToken,
  PUBLIC_BASE_URL: "https://sky.example.com",
  WEBHOOK_SIGNING_KEY: "w".repeat(32),
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

test("parses the env, defaulting PORT, the runner bundle path and the run and wait timeouts", () => {
  expect(loadConfig(required)).toEqual({
    ok: true,
    config: {
      apiKey,
      spritesToken,
      dataDir: "/data",
      port: 8080,
      claudeOauthToken,
      publicBaseUrl: "https://sky.example.com",
      runnerBundlePath: expect.stringMatching(/\/runner\.mjs$/),
      cliBundlePath: expect.stringMatching(/\/sky\.mjs$/),
      runTimeoutMs: 30 * 60_000,
      waitTimeoutMs: 120 * 60_000,
      spritesLongTimeoutMs: 30 * 60_000,
      webhookSigningKey: "w".repeat(32),
      secretEncryptionKey: Buffer.alloc(32, 7),
    },
  });
});

test("RUNNER_BUNDLE_PATH, RUN_TIMEOUT_MINUTES, WAIT_TIMEOUT_MINUTES and SPRITES_LONG_TIMEOUT_MINUTES override their defaults", () => {
  const result = loadConfig({
    ...required,
    RUNNER_BUNDLE_PATH: "/opt/api/runner.mjs",
    RUN_TIMEOUT_MINUTES: "5",
    WAIT_TIMEOUT_MINUTES: "15",
    SPRITES_LONG_TIMEOUT_MINUTES: "45",
  });
  expect(result).toMatchObject({
    ok: true,
    config: {
      runnerBundlePath: "/opt/api/runner.mjs",
      runTimeoutMs: 300_000,
      waitTimeoutMs: 900_000,
      spritesLongTimeoutMs: 2_700_000,
    },
  });
});

test("a SPRITES_LONG_TIMEOUT_MINUTES that isn't a positive number is rejected", () => {
  const result = loadConfig({ ...required, SPRITES_LONG_TIMEOUT_MINUTES: "0" });
  expect(result).toEqual({
    ok: false,
    message: expect.stringContaining("SPRITES_LONG_TIMEOUT_MINUTES is invalid"),
  });
});

test.each([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "PUBLIC_BASE_URL",
  "WEBHOOK_SIGNING_KEY",
])("%s is required", (name) => {
  const result = loadConfig({ ...required, [name]: undefined });
  expect(result).toEqual({
    ok: false,
    message: expect.stringContaining(`${name} is missing`),
  });
});

test("a missing variable is named in the failure", () => {
  const result = loadConfig({ DATA_DIR: "/data" });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.message).toContain("SKY_API_KEY");
    expect(result.message).toContain("SPRITES_TOKEN is missing");
  }
});

test("an invalid value is named by its variable, never echoed", () => {
  const secret = "short-secret-value";
  const result = loadConfig({
    SKY_API_KEY: secret,
    DATA_DIR: "/data",
    PORT: "not-a-port",
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.message).toContain("SKY_API_KEY");
  expect(result.message).toContain("PORT");
  expect(result.message).not.toContain(secret);
  expect(result.message).not.toContain("not-a-port");
});

test("a WEBHOOK_SIGNING_KEY under 32 characters is rejected", () => {
  const result = loadConfig({
    ...required,
    WEBHOOK_SIGNING_KEY: "w".repeat(31),
  });
  expect(result).toEqual({
    ok: false,
    message: expect.stringContaining("WEBHOOK_SIGNING_KEY is invalid"),
  });
});

test.each([
  ["missing", undefined, "SECRET_ENCRYPTION_KEY is missing"],
  [
    "31 bytes",
    Buffer.alloc(31).toString("base64"),
    "SECRET_ENCRYPTION_KEY is invalid",
  ],
  [
    "33 bytes",
    Buffer.alloc(33).toString("base64"),
    "SECRET_ENCRYPTION_KEY is invalid",
  ],
  ["not base64", "!".repeat(44), "SECRET_ENCRYPTION_KEY is invalid"],
])("a SECRET_ENCRYPTION_KEY that is %s is rejected", (_, value, message) => {
  const result = loadConfig({ ...required, SECRET_ENCRYPTION_KEY: value });
  expect(result).toEqual({
    ok: false,
    message: expect.stringContaining(message),
  });
});
