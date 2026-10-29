import type { RunId } from "@harness/shared";
import { expect, test } from "vitest";
import { runnerPattern } from "./launch.js";

const runId = "run_abc123" as RunId;
// pgrep -f matches its ERE against each process's whole command line
const matches = (cmdline: string) =>
  new RegExp(runnerPattern(runId)).test(cmdline);

test("the runner pattern matches the runner whatever path its node is started from", () => {
  expect(matches(`node /opt/harness/runner.mjs ${runId}`)).toBe(true);
  expect(
    matches(
      `/home/sprite/.local/share/mise/installs/node/24/bin/node /opt/harness/runner.mjs ${runId}`,
    ),
  ).toBe(true);
});

test("the runner pattern matches neither another run's runner, the bash parent, the Claude child nor the matcher itself", () => {
  expect(matches(`node /opt/harness/runner.mjs ${runId}9`)).toBe(false);
  expect(
    matches(
      `bash -c set -a && . "$ENV_FILE" && set +a && rm -f "$ENV_FILE" && PROMPT="$(cat "$PROMPT_FILE")" && export PROMPT && exec node /opt/harness/runner.mjs "$RUN_ID"`,
    ),
  ).toBe(false);
  expect(
    matches(
      "node /opt/harness/node_modules/@anthropic-ai/claude-agent-sdk/cli.js --output-format stream-json",
    ),
  ).toBe(false);
  expect(matches(`pkill -TERM -f ${runnerPattern(runId)}`)).toBe(false);
  expect(
    matches(
      `bash -c for _ in ... _ /workspace/worktrees/agt_x ${runnerPattern(runId)}`,
    ),
  ).toBe(false);
});
