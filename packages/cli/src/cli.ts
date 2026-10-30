import { parseArgs } from "node:util";
import { agentCommands } from "./agent.js";
import { ApiError, createApi } from "./api.js";
import { apply } from "./apply.js";
import { type Config, configPath, type Env, resolveConfig } from "./config.js";
import { createOutput, type Output, UsageError } from "./output.js";
import { secretSet } from "./secret.js";

export interface Io {
  argv: string[];
  env: Env;
  home: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  stderrIsTTY: boolean;
  stdin: {
    isTTY: boolean;
    readAll(): Promise<string>;
    /** Reads one line from the terminal without echoing it; the prompt goes to stderr. */
    promptHidden(prompt: string): Promise<string>;
  };
  sleep(ms: number): Promise<void>;
  now(): number;
  /** From return until the returned disarm runs, Ctrl-C prints `sky: <note>` on stderr before the process dies by SIGINT; arm before printing anything that invites a Ctrl-C. */
  onInterrupt(note: string): () => void;
}

const help = (io: Io) => `Usage:
  sky apply <env.yaml> [options]
      Create or update the environment env.yaml describes, wait until it's
      provisioned, and write sky-lock.json beside env.yaml.
  sky secret set <env> <NAME> [--connector=<connection id>] [options]
      Store a secret on an environment (<env> is its id or name). The value
      is read from stdin, or prompted for without echo on a terminal. With
      --connector, agents get the Sprites connection id as $NAME instead.
  sky agent start <env> --prompt=<text|@file> [options]
  sky agent follow-up <agent> --prompt=<text|@file> [options]
      Start an agent on an environment (<env> is its id or name), or queue
      the next run on one; @file reads the prompt from that file. Prints
      "<agentId> <runId>".
  sky agent archive <agent> [options]
      Archive an agent.
  sky inbox <agent> [options]
      Print what the agent's newest run is waiting on: "question <requestId>"
      then the question, or "approval <requestId> <tool>" then what the tool
      would do; nothing when nothing is pending. "<runId> <status>" goes to
      stderr.
  sky wait <agent> [--timeout=<seconds>] [options]
      Wait until the newest run needs input or ends, then print what inbox
      prints. With no --timeout it waits as long as the run takes.
  sky status <agent> [options]
      Print "<runId> <status>", then its summary, error and compare link.
  sky approve <agent> <requestId> [--reason=<text>] [options]
  sky deny <agent> <requestId> --reason=<text> [options]
  sky answer <agent> <requestId> <text> [options]
      Decide a pending request. Repeating a decision that already landed
      exits 0 and says "already resolved".

Options:
  --url=<url>            API URL
  --api-key-env=<VAR>    read the API key from environment variable VAR
  --json                 print the API's object on stdout (inbox, wait and
                         status: the newest run)
  -h, --help             show this help

Configuration, first found wins:
  url:     --url, SKY_URL, "url" in the config file
  API key: --api-key-env, SKY_API_KEY, "apiKey" in the config file
  config file: ${configPath(io.env, io.home)}

Exit status: 0 done; 1 failed (API error, provisioning failed); 2 usage or
  config error, a rejected API key included
  inbox, wait and status exit with the newest run's state:
  0 finished; 3 waiting (needs input); 4 starting or running (wait: timed
  out); 5 failed; 6 stopped
`;

const commonOptions = {
  url: { type: "string" },
  "api-key-env": { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

/** Runs one invocation and returns its exit status; never throws for an expected failure. */
export async function run(io: Io): Promise<number> {
  const [command, ...rest] = io.argv;
  if (
    command === undefined ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  ) {
    (command === undefined ? io.stderr : io.stdout)(help(io));
    return command === undefined ? 2 : 0;
  }
  try {
    switch (command) {
      case "apply":
        return await runApply(rest, io);
      case "secret":
        return await runSecret(rest, io);
      default:
        if (Object.hasOwn(agentCommands, command)) {
          return await runAgent(command, rest, io);
        }
        throw new UsageError(`unknown command '${command}'`, true);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`sky: ${err.message}\n`);
      if (err.showHelpPointer) io.stderr("Run 'sky --help' for usage.\n");
      return 2;
    }
    throw err;
  }
}

function parse<
  O extends Record<string, { type: "string" | "boolean"; short?: string }>,
>(args: string[], options: O) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    if ((err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS_")) {
      throw new UsageError((err as Error).message, true);
    }
    throw err;
  }
}

function connect(values: { url?: string; "api-key-env"?: string }, io: Io) {
  const resolved = resolveConfig(
    { url: values.url, apiKeyEnv: values["api-key-env"] },
    io.env,
    io.home,
  );
  if (!resolved.ok) throw new UsageError(resolved.error);
  return { api: createApi(resolved.config), config: resolved.config };
}

async function runApply(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, commonOptions);
  if (values.help) {
    io.stdout(help(io));
    return 0;
  }
  if (positionals.length !== 1) {
    throw new UsageError("apply takes one argument, the env.yaml path", true);
  }
  const out = createOutput(values.json ?? false, io.stdout, io.stderr);
  const file = positionals[0] as string;
  const { api, config } = connect(values, io);
  try {
    return await apply(file, api, io, out);
  } catch (err) {
    if (err instanceof ApiError) return failApi(err, config, out);
    throw err;
  }
}

async function runSecret(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, {
    ...commonOptions,
    connector: { type: "string" },
  });
  if (values.help) {
    io.stdout(help(io));
    return 0;
  }
  const [sub, envRef, name, ...extra] = positionals;
  if (sub !== "set") {
    throw new UsageError(
      sub === undefined
        ? "secret needs a subcommand: set"
        : `unknown secret subcommand '${sub}'`,
      true,
    );
  }
  if (envRef === undefined || name === undefined || extra.length > 0) {
    // never echo the extra arguments: one of them may be a value typed where it doesn't belong
    throw new UsageError(
      "secret set takes <env> <NAME>; the value is read from stdin, not argv",
      true,
    );
  }
  const out = createOutput(values.json ?? false, io.stdout, io.stderr);
  const { api, config } = connect(values, io);
  try {
    return await secretSet(envRef, name, values.connector, api, io, out);
  } catch (err) {
    if (err instanceof ApiError) return failApi(err, config, out);
    throw err;
  }
}

async function runAgent(
  command: string,
  args: string[],
  io: Io,
): Promise<number> {
  const spec = agentCommands[command] as (typeof agentCommands)[string];
  const { values, positionals } = parse(args, {
    ...commonOptions,
    ...spec.options,
  });
  if (values.help) {
    io.stdout(help(io));
    return 0;
  }
  // every agent option is a string; parseArgs types a spread option set as string | boolean
  const text = (v: string | boolean | undefined) =>
    typeof v === "string" ? v : undefined;
  const action = spec.prepare(positionals, {
    prompt: text(values.prompt),
    timeout: text(values.timeout),
    reason: text(values.reason),
  });
  const out = createOutput(values.json ?? false, io.stdout, io.stderr);
  const { api, config } = connect(values, io);
  try {
    return await action(api, io, out);
  } catch (err) {
    if (err instanceof ApiError) return failApi(err, config, out);
    throw err;
  }
}

/** A rejected key is a config error (2): retrying with the same key can't succeed. */
function failApi(err: ApiError, config: Config, out: Output): number {
  const showCode = !out.json && err.code !== "unreachable";
  const message = showCode ? `${err.message} (${err.code})` : err.message;
  if (err.status === 401) {
    out.fail(err.code, `${message}; check the key from ${config.apiKeySource}`);
    return 2;
  }
  return out.fail(err.code, message);
}
