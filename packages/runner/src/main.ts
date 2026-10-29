import { query } from "@anthropic-ai/claude-agent-sdk";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { createPoster } from "./events.js";
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

  // the first SIGTERM/SIGINT aborts the session and lets the run report and commit; a second one kills at once
  const controller = new AbortController();
  let caught: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    caught = signal;
    controller.abort(signal);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  try {
    process.exitCode = await runSession(config, {
      query,
      post: createPoster({ ...config, warn }),
      awaitDecision: createDecisionWaiter(config),
      signal: controller.signal,
    });
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
  // die by the signal so the caller sees the process was stopped, not that it failed
  if (caught) process.kill(process.pid, caught);
}

main().catch((error: unknown) => {
  warn(`runner: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
