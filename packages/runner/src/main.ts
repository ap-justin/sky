import { query } from "@anthropic-ai/claude-agent-sdk";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { writeClaudeCredentials } from "./credentials.js";
import { createPoster } from "./events.js";
import { holdSprite } from "./keepalive.js";
import { publishMain } from "./publish.js";
import { createDecisionWaiter } from "./requests.js";
import { runSession } from "./session.js";

const warn = (message: string) => process.stderr.write(`${message}\n`);

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    warn(`runner: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  // the first SIGTERM/SIGINT/SIGHUP aborts the session and lets the run report and commit; a second one kills at once
  const controller = new AbortController();
  let caught: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    caught = signal;
    controller.abort(signal);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  // a hangup from the exec session that started the runner is a stop, not a death
  process.once("SIGHUP", onSignal);
  // so a nested `claude -p` in the sandbox is logged in; a failure costs the Kru checks, not the run
  await writeClaudeCredentials(process.env).catch((error: unknown) =>
    warn(
      `runner: nested claude login not set up: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
  // held through waits for a decision too: a paused sprite drops the long-poll and the event posts
  const hold = holdSprite({ runId: config.runId, warn });

  try {
    process.exitCode = await runSession(config, {
      query,
      post: createPoster({ ...config, warn }),
      awaitDecision: createDecisionWaiter(config),
      signal: controller.signal,
      warn,
    });
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    process.off("SIGHUP", onSignal);
    await hold.release();
  }
  // die by the signal so the caller sees the process was stopped, not that it failed
  if (caught) process.kill(process.pid, caught);
}

// `runner.mjs publish …` is the agent's own command, run from its worktree; anything else is a run
const entry =
  process.argv[2] === "publish"
    ? publishMain(process.argv.slice(3), process.env, {
        cwd: process.cwd(),
        stdout: (s) => process.stdout.write(s),
        stderr: (s) => process.stderr.write(s),
      }).then((code) => {
        process.exitCode = code;
      })
    : main();

entry.catch((error: unknown) => {
  warn(`runner: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
