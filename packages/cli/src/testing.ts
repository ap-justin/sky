import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Io, run } from "./cli.js";

export const apiUrl = "https://harness.test";
export const apiKey = "hk_test_secret_key";

export interface Captured {
  code: number;
  stdout: string;
  stderr: string;
  sleeps: number[];
}

/** Runs the CLI in-process against MSW with a fake clock that `sleep` advances. */
export async function runCli(
  argv: string[],
  opts: {
    env?: Record<string, string | undefined>;
    stdin?: Partial<Io["stdin"]>;
    stderrIsTTY?: boolean;
  } = {},
): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  let clock = 0;
  const sleeps: number[] = [];
  const code = await run({
    argv,
    env: {
      HARNESS_URL: apiUrl,
      HARNESS_API_KEY: apiKey,
      ...opts.env,
    },
    home: mkdtempSync(join(tmpdir(), "harness-home-")),
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
    stderrIsTTY: opts.stderrIsTTY ?? false,
    stdin: {
      isTTY: false,
      readAll: async () => "",
      promptHidden: async () => {
        throw new Error("unexpected prompt");
      },
      ...opts.stdin,
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  return { code, stdout, stderr, sleeps };
}
