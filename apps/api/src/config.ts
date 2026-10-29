import { z } from "zod";

// bearerAuth rejects any token outside RFC 6750's token68 charset, so a key outside it could never match
const configSchema = z.object({
  HARNESS_API_KEY: z
    .string()
    .min(32)
    .regex(/^[A-Za-z0-9._~+/-]+=*$/),
  SPRITES_TOKEN: z.string().min(1),
  DATA_DIR: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
});

export type Config = {
  apiKey: string;
  spritesToken: string;
  dataDir: string;
  port: number;
};

type Env = Record<string, string | undefined>;

/** Names each bad variable; values stay out of the message since one is a secret. */
export function loadConfig(
  env: Env,
): { ok: true; config: Config } | { ok: false; message: string } {
  const parsed = configSchema.safeParse(env);
  if (parsed.success) {
    const { HARNESS_API_KEY, SPRITES_TOKEN, DATA_DIR, PORT } = parsed.data;
    return {
      ok: true,
      config: {
        apiKey: HARNESS_API_KEY,
        spritesToken: SPRITES_TOKEN,
        dataDir: DATA_DIR,
        port: PORT,
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
