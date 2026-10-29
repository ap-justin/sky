import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, test } from "vitest";

// the built binary in a child process: exit codes, streams and real stdin, which an in-process run can't show
const pkg = join(import.meta.dirname, "..");
const bin = join(pkg, "dist", "bundle", "harness.mjs");

beforeAll(() => {
  execFileSync("pnpm", ["run", "--silent", "build"], {
    cwd: pkg,
    stdio: "ignore",
  });
}, 60_000);

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
  const r = await harness(["apply", "env.yaml"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/no API URL/);
});
