import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// the built binary in a child process: exit codes, streams and real stdin, which an in-process run can't show
const pkg = join(import.meta.dirname, "..");
const bin = join(pkg, "dist", "bundle", "harness.mjs");

let api: Server;
let apiUrl: string;
const received: { url: string; body: string }[] = [];

beforeAll(async () => {
  execFileSync("pnpm", ["run", "--silent", "build"], {
    cwd: pkg,
    stdio: "ignore",
  });
  api = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      received.push({ url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ name: "TOKEN", kind: "value" }));
    });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
}, 60_000);

afterAll(() => new Promise<void>((resolve) => api.close(() => resolve())));

function harness(
  args: string[],
  opts: { env?: Record<string, string>; stdin?: string } = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(process.execPath, [bin, ...args], {
        // a fresh HOME so no real config file is read
        env: {
          PATH: process.env.PATH ?? "",
          HOME: mkdtempSync(join(tmpdir(), "harness-bin-")),
          ...opts.env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => {
        stdout += c;
      });
      child.stderr.on("data", (c) => {
        stderr += c;
      });
      child.stdin.end(opts.stdin ?? "");
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    },
  );
}

test("--help goes to stdout and exits 0", async () => {
  const r = await harness(["--help"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/^Usage:/);
  expect(r.stderr).toBe("");
});

test("a usage error exits 2 with nothing on stdout", async () => {
  const r = await harness(["apply"]);
  expect(r.code).toBe(2);
  expect(r.stdout).toBe("");
  expect(r.stderr).toMatch(/Run 'harness --help' for usage/);
});

test("no configuration exits 2", async () => {
  const r = await harness(["secret", "set", "env_1", "TOKEN"], { stdin: "v" });
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/no API URL/);
});

test("an unreachable API exits 1", async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
  await new Promise((resolve) => closed.close(resolve));
  const r = await harness(["secret", "set", "env_1", "TOKEN"], {
    env: { HARNESS_URL: url, HARNESS_API_KEY: "k" },
    stdin: "v",
  });
  expect(r.code).toBe(1);
  expect(r.stderr).toBe(`harness: cannot reach ${url}: ECONNREFUSED\n`);
});

test("a piped secret reaches the API and neither output stream", async () => {
  const value = "piped-secret-value-xyz";
  const r = await harness(["secret", "set", "env_1", "TOKEN"], {
    env: { HARNESS_URL: apiUrl, HARNESS_API_KEY: "test-key" },
    stdin: `${value}\n`,
  });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("set TOKEN (value)\n");
  expect(r.stdout + r.stderr).not.toContain(value);
  expect(r.stdout + r.stderr).not.toContain("test-key");
  expect(received.at(-1)).toEqual({
    url: "/v1/environments/env_1/secrets/TOKEN",
    body: JSON.stringify({ value }),
  });
});
