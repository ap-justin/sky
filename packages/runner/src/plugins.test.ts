import { describe, expect, test, vi } from "vitest";
import { claudeBinary, refreshPlugins } from "./plugins.js";

const listing = JSON.stringify([
  { id: "kru@kru", scope: "user" },
  { id: "kru@kru", scope: "project" },
  { id: "other@kru", scope: "user" },
]);

describe("refreshPlugins", () => {
  test("refreshes the marketplaces, updates each user-scope plugin once, and logs the duration", async () => {
    const calls: string[][] = [];
    const warn = vi.fn();
    let t = 0;
    await refreshPlugins({
      env: { A: "b" },
      warn,
      claude: "claude-bin",
      now: () => (t += 1500),
      run: async (file, args, { env }) => {
        expect(file).toBe("claude-bin");
        expect(env).toEqual({ A: "b" });
        calls.push(args);
        return { stdout: args[1] === "list" ? listing : "" };
      },
    });
    expect(calls).toEqual([
      ["plugin", "list", "--json"],
      ["plugin", "marketplace", "update"],
      ["plugin", "update", "kru@kru", "--scope", "user"],
      ["plugin", "update", "other@kru", "--scope", "user"],
    ]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toBe(
      "runner: plugins refreshed in 1.5s (kru@kru, other@kru)",
    );
  });

  test("a failing command is one warning and does not throw", async () => {
    const warn = vi.fn();
    await refreshPlugins({
      env: {},
      warn,
      claude: "c",
      run: async (_f, args) => {
        if (args[1] === "marketplace") throw new Error("clone failed\nmore");
        return { stdout: listing };
      },
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /plugin refresh failed \(clone failed\); continuing/,
    );
  });

  test("a hung command is cut at the timeout and the session continues", async () => {
    const warn = vi.fn();
    await refreshPlugins({
      env: {},
      warn,
      claude: "c",
      timeoutMs: 50,
      run: (_f, _a, { signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/timed out after .*continuing/);
  });
});

test("claudeBinary prefers SKY_CLAUDE, else falls back to claude", () => {
  expect(claudeBinary({ SKY_CLAUDE: "/x/claude" })).toBe("/x/claude");
  expect(claudeBinary({}, "/nonexistent/runner.mjs")).toBe("claude");
});
