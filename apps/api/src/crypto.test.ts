import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { envSecretAad, open, runEnvVarAad, seal } from "./crypto.js";

const key = randomBytes(32);

test("a sealed value opens under the same key and AAD, and its ciphertext holds no plaintext", () => {
  const sealed = seal(key, "ghp_plaintext-value", "env:env_1:GITHUB_TOKEN");
  expect(sealed.keyVersion).toBe(1);
  expect(sealed.nonce).toHaveLength(12);
  expect(sealed.ciphertext.toString("latin1")).not.toContain("plaintext");
  expect(open(key, sealed, "env:env_1:GITHUB_TOKEN")).toBe(
    "ghp_plaintext-value",
  );
});

test("each seal draws a fresh nonce", () => {
  const a = seal(key, "same", "env:env_1:X");
  const b = seal(key, "same", "env:env_1:X");
  expect(a.nonce.equals(b.nonce)).toBe(false);
  expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
});

test("a value moved to another row, or opened under another key, is refused", () => {
  const sealed = seal(key, "value", "env:env_1:A");
  expect(() => open(key, sealed, "env:env_2:A")).toThrow();
  expect(() => open(randomBytes(32), sealed, "env:env_1:A")).toThrow();
});

test("the AAD names the row: env secrets by env and name, run envVars by run and name", () => {
  expect(envSecretAad("env_1", "TOKEN")).toBe("env:env_1:TOKEN");
  expect(runEnvVarAad("run_1", "TOKEN")).toBe("run:run_1:TOKEN");
  const aads = [
    envSecretAad("env_1", "A"),
    envSecretAad("env_2", "A"),
    envSecretAad("env_1", "B"),
    runEnvVarAad("env_1", "A"),
  ];
  expect(new Set(aads).size).toBe(aads.length);
});
