#!/usr/bin/env node
import { homedir } from "node:os";
import { text } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import { run } from "./cli.js";

// a reader that stops early (`| head`) is not a failure
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

/** Raw mode so nothing echoes; node has no built-in no-echo read. */
function promptHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          finish();
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          // raw mode swallows Ctrl-C's signal; raise it so the shell sees an interrupt
          finish();
          process.kill(process.pid, "SIGINT");
          return;
        }
        value =
          ch === "\u007f" || ch === "\b" ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.on("data", onData);
  });
}

try {
  process.exitCode = await run({
    argv: process.argv.slice(2),
    env: process.env,
    home: homedir(),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    stderrIsTTY: process.stderr.isTTY === true,
    stdin: {
      isTTY: process.stdin.isTTY === true,
      readAll: () => text(process.stdin),
      promptHidden,
    },
    sleep: (ms) => sleep(ms),
    now: () => Date.now(),
    onInterrupt: (note) => {
      const onSigint = () => {
        // `once` has already removed this listener, so the re-raise takes the default death
        process.stderr.write(`sky: ${note}\n`, () =>
          process.kill(process.pid, "SIGINT"),
        );
      };
      process.once("SIGINT", onSigint);
      return () => process.off("SIGINT", onSigint);
    },
  });
} catch (err) {
  process.stderr.write(
    `sky: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
}
