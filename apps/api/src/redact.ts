import type { Config } from "./config.js";

const REDACTED = "[redacted]";

// \b keeps words like "task-list" (which contains "sk-") out of the sk- match
const tokenPatterns = [
  /\bsk-ant-oat[0-9A-Za-z_-]+/g,
  /\bsk-[0-9A-Za-z_-]{16,}/g,
  /\bghp_[0-9A-Za-z]{20,}/g,
  /\bgithub_pat_[0-9A-Za-z_]{20,}/g,
  /\beyJ[0-9A-Za-z_-]+\.[0-9A-Za-z_-]+\.[0-9A-Za-z_-]+/g,
];

/** Scrubs credential-shaped strings and this deployment's own secrets from text bound for an API response or log. */
export function redact(
  text: string,
  secrets: Pick<Config, "apiKey" | "spritesToken">,
): string {
  let out = text;
  for (const secret of [secrets.apiKey, secrets.spritesToken]) {
    if (secret) out = out.split(secret).join(REDACTED);
  }
  for (const pattern of tokenPatterns) out = out.replace(pattern, REDACTED);
  return out;
}
