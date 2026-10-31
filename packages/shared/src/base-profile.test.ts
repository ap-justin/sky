import { expect, test } from "vitest";
import { BaseProfile, BaseProfileName, BaseProfiles } from "./base-profile.js";

test("an empty profile parses to no marketplaces, plugins, servers, session variables or checks", () => {
  expect(BaseProfile.parse({})).toEqual({
    marketplaces: [],
    plugins: [],
    mcpServers: {},
    sessionEnv: {},
    checks: [],
  });
});

test("a stdio and an http MCP server both parse, and credentials are secret names", () => {
  const profile = BaseProfile.parse({
    mcpServers: {
      local: { command: "npx", args: ["-y", "x"], env: { API_KEY: "X_KEY" } },
      remote: {
        url: "https://x.example.com/mcp",
        headers: { Authorization: "X_AUTH" },
      },
    },
  });
  expect(profile.mcpServers.local).toEqual({
    command: "npx",
    args: ["-y", "x"],
    env: { API_KEY: "X_KEY" },
  });
  expect(profile.mcpServers.remote).toEqual({
    url: "https://x.example.com/mcp",
    headers: { Authorization: "X_AUTH" },
  });
});

test.each([
  [
    "an inline secret value in env",
    { x: { command: "x", env: { K: "sk-live-123 abc" } } },
  ],
  [
    "an inline secret value in headers",
    { x: { url: "https://x.example.com", headers: { A: "Bearer abc" } } },
  ],
  [
    "a server with both command and url",
    { x: { command: "x", url: "https://x.example.com" } },
  ],
  ["a non-http url", { x: { url: "file:///etc/passwd" } }],
  ["a server name with a space", { "a b": { command: "x" } }],
])("rejects %s", (_, mcpServers) => {
  expect(BaseProfile.safeParse({ mcpServers }).success).toBe(false);
});

test.each([
  [{ storeLayout: { home: "../out" } }],
  [{ storeLayout: { home: "/abs" } }],
  [{ storeLayout: { mergeScript: "a/../../b" } }],
  [{ plugins: ["no-marketplace"] }],
  [{ marketplaces: ["-x"] }],
  [{ checks: [""] }],
  [{ unknown: true }],
])("rejects %j", (profile) => {
  expect(BaseProfile.safeParse(profile).success).toBe(false);
});

test("a store layout defaults its home and keeps its patterns", () => {
  expect(
    BaseProfile.parse({
      storeRepo: "a/b",
      storeLayout: { lineFiles: ["*.log"] },
    }).storeLayout,
  ).toEqual({
    home: ".sky-store",
    exclude: [],
    lineFiles: ["*.log"],
  });
});

test("profile names are letters, digits and . _ -", () => {
  expect(BaseProfileName.safeParse("kru-1.a_b").success).toBe(true);
  for (const bad of ["", "a b", "-a", "a/b", "x".repeat(65)]) {
    expect(BaseProfileName.safeParse(bad).success).toBe(false);
  }
  expect(BaseProfiles.safeParse({ "a b": {} }).success).toBe(false);
});
