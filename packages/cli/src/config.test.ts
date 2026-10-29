import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resolveConfig } from "./config.js";

const home = () => mkdtempSync(join(tmpdir(), "harness-cli-"));
const withConfigFile = (contents: string) => {
  const dir = home();
  mkdirSync(join(dir, ".config", "harness"), { recursive: true });
  writeFileSync(join(dir, ".config", "harness", "config.json"), contents);
  return dir;
};

test("flags beat env beat the config file", () => {
  const dir = withConfigFile(
    JSON.stringify({ url: "https://file.example", apiKey: "file-key" }),
  );
  expect(resolveConfig({}, {}, dir)).toEqual({
    ok: true,
    config: { url: "https://file.example", apiKey: "file-key" },
  });
  const env = {
    HARNESS_URL: "https://env.example",
    HARNESS_API_KEY: "env-key",
    OTHER_KEY: "other-key",
  };
  expect(resolveConfig({}, env, dir)).toEqual({
    ok: true,
    config: { url: "https://env.example", apiKey: "env-key" },
  });
  expect(
    resolveConfig(
      { url: "https://flag.example", apiKeyEnv: "OTHER_KEY" },
      env,
      dir,
    ),
  ).toEqual({
    ok: true,
    config: { url: "https://flag.example", apiKey: "other-key" },
  });
});

test("an empty env var doesn't count as set", () => {
  const dir = withConfigFile(
    JSON.stringify({ url: "https://file.example", apiKey: "file-key" }),
  );
  expect(
    resolveConfig({}, { HARNESS_URL: "", HARNESS_API_KEY: "" }, dir),
  ).toEqual({
    ok: true,
    config: { url: "https://file.example", apiKey: "file-key" },
  });
});

test("honors XDG_CONFIG_HOME", () => {
  const xdg = home();
  mkdirSync(join(xdg, "harness"));
  writeFileSync(
    join(xdg, "harness", "config.json"),
    JSON.stringify({ url: "https://xdg.example", apiKey: "k" }),
  );
  expect(resolveConfig({}, { XDG_CONFIG_HOME: xdg }, home())).toMatchObject({
    ok: true,
    config: { url: "https://xdg.example" },
  });
});

test("--api-key-env naming an unset variable is an error, not a fallback", () => {
  const result = resolveConfig(
    { apiKeyEnv: "MISSING" },
    { HARNESS_URL: "https://env.example", HARNESS_API_KEY: "env-key" },
    home(),
  );
  expect(result).toEqual({
    ok: false,
    error: "--api-key-env names MISSING, which is not set",
  });
});

test("nothing configured names where to put it", () => {
  const result = resolveConfig({}, {}, home());
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatch(/no API URL/);
  expect(result.error).toMatch(/HARNESS_URL/);
});

test("a malformed config file is an error naming the file", () => {
  const dir = withConfigFile("{not json");
  const result = resolveConfig({}, {}, dir);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain(
    join(dir, ".config", "harness", "config.json"),
  );
});

test("a trailing slash on the URL is dropped", () => {
  expect(
    resolveConfig(
      {},
      { HARNESS_URL: "https://env.example/", HARNESS_API_KEY: "k" },
      home(),
    ),
  ).toMatchObject({ config: { url: "https://env.example" } });
});
