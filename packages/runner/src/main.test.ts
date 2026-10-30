import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

const pkg = join(import.meta.dirname, "..");
const bundle = join(pkg, "dist/bundle/runner.mjs");

beforeAll(() => {
  execFileSync("pnpm", ["run", "--silent", "build"], { cwd: pkg });
}, 30_000);

// the runner writes Claude Code's credential file; keep it out of the real home
const CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "runner-claude-"));
afterAll(() => rmSync(CLAUDE_CONFIG_DIR, { recursive: true, force: true }));

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

async function runBundle(env: Record<string, string>) {
  const child = spawn(process.execPath, [bundle], {
    env: { PATH: process.env.PATH ?? "", CLAUDE_CONFIG_DIR, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}

test("missing env is a usage error: exit 2, one line on stderr, nothing on stdout", async () => {
  const { code, stdout, stderr } = await runBundle({
    AGENT_TOKEN: "agent-secret",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
  });
  expect(code).toBe(2);
  expect(stdout).toBe("");
  expect(stderr.trim().split("\n")).toHaveLength(1);
  expect(stderr).toMatch(/AGENT_ID/);
  expect(stderr).not.toMatch(/secret/);
});

test("a failed run posts run.failed to the API with the agent token, exits 1, and leaves nothing running", async () => {
  const received: { auth?: string; body: unknown }[] = [];
  const api = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received.push({
        auth: req.headers.authorization,
        body: JSON.parse(body),
      });
      res.writeHead(204).end();
    });
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const { port } = api.address() as AddressInfo;
  try {
    const { code, stdout } = await runBundle({
      AGENT_ID: "agt_1",
      RUN_ID: "run_1",
      PROMPT: "do it",
      API_BASE_URL: `http://127.0.0.1:${port}`,
      AGENT_TOKEN: "agent-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
      REPO_DIR: "/nonexistent/repo",
      WORKTREES_DIR: "/nonexistent/worktrees",
    });
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(received).toEqual([
      {
        auth: "Bearer agent-secret",
        body: {
          runId: "run_1",
          type: "run.failed",
          payload: { error: expect.stringMatching(/worktree setup failed/) },
        },
      },
    ]);
  } finally {
    api.closeAllConnections();
    api.close();
  }
  // an idle keep-alive socket or a live child would hold the process open: runBundle then never
  // resolves and the timeout fails the test, with no wall-clock threshold to tune
}, 20_000);

test("SIGHUP is a stop like SIGTERM: the run still reports, then the runner dies by the signal", async () => {
  let respond: (() => void) | undefined;
  const posted = new Promise<void>((resolve) => {
    const api = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        respond = () => res.writeHead(204).end();
        resolve();
      });
    });
    api.listen(0, "127.0.0.1");
    servers.push(api);
  });
  const api = servers.at(-1);
  if (!api) throw new Error("no server");
  await once(api, "listening");
  const { port } = api.address() as AddressInfo;
  const child = spawn(process.execPath, [bundle], {
    env: {
      PATH: process.env.PATH ?? "",
      CLAUDE_CONFIG_DIR,
      AGENT_ID: "agt_1",
      RUN_ID: "run_1",
      PROMPT: "do it",
      API_BASE_URL: `http://127.0.0.1:${port}`,
      AGENT_TOKEN: "agent-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
      REPO_DIR: "/nonexistent/repo",
      WORKTREES_DIR: "/nonexistent/worktrees",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = once(child, "exit");
  // the runner is mid-post of run.failed, the API holding its answer
  await posted;
  child.kill("SIGHUP");
  await new Promise((r) => setTimeout(r, 300));
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  respond?.();
  const [code, signal] = await exited;
  expect({ code, signal }).toEqual({ code: null, signal: "SIGHUP" });
  // the sprite hold has no socket outside a sprite, and says so
  expect(stderr).toMatch(/sprite API/);
});
