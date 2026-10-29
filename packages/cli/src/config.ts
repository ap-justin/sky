import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

export type Env = Record<string, string | undefined>;

export interface Config {
  url: string;
  apiKey: string;
}

export interface ConfigFlags {
  url?: string;
  apiKeyEnv?: string;
}

export type ConfigResult =
  | { ok: true; config: Config }
  | { ok: false; error: string };

const ConfigFile = z.object({
  url: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
});

/** `$XDG_CONFIG_HOME/harness/config.json`, else `~/.config/harness/config.json` — on macOS too. */
export function configPath(env: Env, home: string): string {
  const xdg = env.XDG_CONFIG_HOME;
  // the XDG spec ignores an empty or relative value
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, ".config");
  return join(base, "harness", "config.json");
}

const nonEmpty = (v: string | undefined) => (v ? v : undefined);

/** flags > env (`HARNESS_URL`, `HARNESS_API_KEY`) > the user config file. */
export function resolveConfig(
  flags: ConfigFlags,
  env: Env,
  home: string,
): ConfigResult {
  let flagKey: string | undefined;
  if (flags.apiKeyEnv !== undefined) {
    flagKey = nonEmpty(env[flags.apiKeyEnv]);
    if (flagKey === undefined) {
      return {
        ok: false,
        error: `--api-key-env names ${flags.apiKeyEnv}, which is not set`,
      };
    }
  }
  let url = nonEmpty(flags.url) ?? nonEmpty(env.HARNESS_URL);
  let apiKey = flagKey ?? nonEmpty(env.HARNESS_API_KEY);
  const path = configPath(env, home);
  if (url === undefined || apiKey === undefined) {
    const file = readConfigFile(path);
    if (!file.ok) return file;
    url ??= file.value.url;
    apiKey ??= file.value.apiKey;
  }
  if (url === undefined) {
    return {
      ok: false,
      error: `no API URL: pass --url, set HARNESS_URL, or add "url" to ${path}`,
    };
  }
  if (apiKey === undefined) {
    return {
      ok: false,
      error: `no API key: set HARNESS_API_KEY, pass --api-key-env=<VAR>, or add "apiKey" to ${path}`,
    };
  }
  return { ok: true, config: { url: url.replace(/\/+$/, ""), apiKey } };
}

function readConfigFile(
  path: string,
):
  | { ok: true; value: z.infer<typeof ConfigFile> }
  | { ok: false; error: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, value: {} };
    }
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: `${path}: not valid JSON` };
  }
  const parsed = ConfigFile.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: `${path}: expected {"url": string, "apiKey": string}`,
    };
  }
  return { ok: true, value: parsed.data };
}
