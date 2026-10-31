import { fileURLToPath } from "node:url";
import { z } from "zod";

// the build copies the runner bundle next to the API bundle, which is where this module lands
const bundledRunner = fileURLToPath(new URL("./runner.mjs", import.meta.url));

// likewise the CLI bundle, which GET /cli/sky.mjs serves
const bundledCli = fileURLToPath(new URL("./sky.mjs", import.meta.url));

const configSchema = z.object({
  /** Token68 only: bearerAuth rejects any token outside RFC 6750's token68 charset, so a key outside it could never match. */
  SKY_API_KEY: z
    .string()
    .min(32)
    .regex(/^[A-Za-z0-9._~+/-]+=*$/),
  SPRITES_TOKEN: z.string().min(1),
  DATA_DIR: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1),
  /** How a sprite reaches this API; the runner posts its events here. */
  PUBLIC_BASE_URL: z.url({ protocol: /^https?$/ }),
  RUNNER_BUNDLE_PATH: z.string().min(1).default(bundledRunner),
  CLI_BUNDLE_PATH: z.string().min(1).default(bundledCli),
  /** A run with no event for this long is failed with `runner_timeout`. */
  RUN_TIMEOUT_MINUTES: z.coerce.number().positive().default(30),
  /** How long a runner waits on a question or approval before giving up; the runner gets it at launch. */
  WAIT_TIMEOUT_MINUTES: z.coerce.number().positive().default(120),
  /** The bound on a sprite's clone, installs, setup script, Kru store steps and checkpoint. */
  SPRITES_LONG_TIMEOUT_MINUTES: z.coerce.number().positive().default(30),
  /** HMAC key every outbound webhook delivery is signed with. */
  WEBHOOK_SIGNING_KEY: z.string().min(32),
  /** AES-256 key, base64, that env secrets and run envVars are encrypted under. */
  SECRET_ENCRYPTION_KEY: z
    .base64()
    .refine((s) => Buffer.from(s, "base64").length === 32, {
      error: "must decode to 32 bytes",
    }),
});

export type Config = {
  apiKey: string;
  spritesToken: string;
  dataDir: string;
  port: number;
  claudeOauthToken: string;
  publicBaseUrl: string;
  runnerBundlePath: string;
  cliBundlePath: string;
  runTimeoutMs: number;
  waitTimeoutMs: number;
  spritesLongTimeoutMs: number;
  webhookSigningKey: string;
  secretEncryptionKey: Buffer;
};

type Env = Record<string, string | undefined>;

/** Names each bad variable; values stay out of the message since some are secrets. */
export function loadConfig(
  env: Env,
): { ok: true; config: Config } | { ok: false; message: string } {
  const parsed = configSchema.safeParse(env);
  if (parsed.success) {
    const e = parsed.data;
    return {
      ok: true,
      config: {
        apiKey: e.SKY_API_KEY,
        spritesToken: e.SPRITES_TOKEN,
        dataDir: e.DATA_DIR,
        port: e.PORT,
        claudeOauthToken: e.CLAUDE_CODE_OAUTH_TOKEN,
        publicBaseUrl: e.PUBLIC_BASE_URL,
        runnerBundlePath: e.RUNNER_BUNDLE_PATH,
        cliBundlePath: e.CLI_BUNDLE_PATH,
        runTimeoutMs: e.RUN_TIMEOUT_MINUTES * 60_000,
        waitTimeoutMs: e.WAIT_TIMEOUT_MINUTES * 60_000,
        spritesLongTimeoutMs: e.SPRITES_LONG_TIMEOUT_MINUTES * 60_000,
        webhookSigningKey: e.WEBHOOK_SIGNING_KEY,
        secretEncryptionKey: Buffer.from(e.SECRET_ENCRYPTION_KEY, "base64"),
      },
    };
  }
  // zod's default issue messages describe the rule, never the input
  const problems = parsed.error.issues.map((issue) => {
    const name = String(issue.path[0]);
    return env[name] === undefined
      ? `${name} is missing`
      : `${name} is invalid: ${issue.message}`;
  });
  return { ok: false, message: `invalid config: ${problems.join("; ")}` };
}
