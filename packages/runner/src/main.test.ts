import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { beforeAll, expect, test } from "vitest";

const pkg = join(import.meta.dirname, "..");
const bundle = join(pkg, "dist/bundle/runner.mjs");

beforeAll(() => {
  execFileSync("pnpm", ["run", "--silent", "build"], { cwd: pkg });
}, 30_000);

async function runBundle(env: Record<string, string>) {
  const child = spawn(process.execPath, [bundle], {
    env: { PATH: process.env.PATH ?? "", ...env },
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
    const started = Date.now();
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
    // an idle keep-alive socket or a live child would hold the process open past this
    expect(Date.now() - started).toBeLessThan(3000);
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
});
