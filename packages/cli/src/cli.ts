import { parseArgs } from "node:util";
import { ApiError, createApi } from "./api.js";
import { apply } from "./apply.js";
import { configPath, type Env, resolveConfig } from "./config.js";
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
}

const help = (io: Io) => `Usage:
  harness apply <env.yaml> [options]
      Create or update the environment env.yaml describes, wait until it's
      provisioned, and write harness-lock.json beside env.yaml.
  harness secret set <env> <NAME> [--connector=<name>] [options]
      Store a secret on an environment (<env> is its id or name). The value
      is read from stdin, or prompted for without echo on a terminal.

Options:
  --url=<url>            API URL
  --api-key-env=<VAR>    read the API key from environment variable VAR
  --json                 print the API's object on stdout
  -h, --help             show this help

Configuration, first found wins:
  url:     --url, HARNESS_URL, "url" in the config file
  API key: --api-key-env, HARNESS_API_KEY, "apiKey" in the config file
  config file: ${configPath(io.env, io.home)}

Exit status: 0 done · 1 failed (API error, provisioning failed) · 2 usage or config error
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
        throw new UsageError(`unknown command '${command}'`, true);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`harness: ${err.message}\n`);
      if (err.showHelpPointer) io.stderr("Run 'harness --help' for usage.\n");
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
  return createApi(resolved.config);
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
  const api = connect(values, io);
  try {
    return await apply(file, api, io, out);
  } catch (err) {
    if (err instanceof ApiError) return failApi(err, out);
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
  const api = connect(values, io);
  try {
    return await secretSet(envRef, name, values.connector, api, io, out);
  } catch (err) {
    if (err instanceof ApiError) return failApi(err, out);
    throw err;
  }
}

function failApi(err: ApiError, out: Output): number {
  const showCode = !out.json && err.code !== "unreachable";
  return out.fail(
    err.code,
    showCode ? `${err.message} (${err.code})` : err.message,
  );
}
