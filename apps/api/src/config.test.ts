import { expect, test } from "vitest";
import { loadConfig } from "./config.js";

const apiKey = "k".repeat(40);

test("parses the env, defaulting PORT to 8080", () => {
  expect(loadConfig({ HARNESS_API_KEY: apiKey, DATA_DIR: "/data" })).toEqual({
    ok: true,
    config: { apiKey, dataDir: "/data", port: 8080 },
  });
});

test("a missing variable is named in the failure", () => {
  const result = loadConfig({ DATA_DIR: "/data" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toContain("HARNESS_API_KEY");
});

test("an invalid value is named by its variable, never echoed", () => {
  const secret = "short-secret-value";
  const result = loadConfig({
    HARNESS_API_KEY: secret,
    DATA_DIR: "/data",
    PORT: "not-a-port",
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.message).toContain("HARNESS_API_KEY");
  expect(result.message).toContain("PORT");
  expect(result.message).not.toContain(secret);
  expect(result.message).not.toContain("not-a-port");
});
