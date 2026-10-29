import { createHmac, timingSafeEqual } from "node:crypto";

/** A run's runner credential, derived from the API key so none is stored; a key rotation revokes them all. */
export const mintAgentToken = (apiKey: string, runId: string) =>
  createHmac("sha256", apiKey)
    .update(`agent-token:${runId}`)
    .digest("base64url");

/** Constant-time check that `token` is `runId`'s agent token. */
export function isAgentTokenFor(
  apiKey: string,
  runId: string,
  token: string,
): boolean {
  const expected = Buffer.from(mintAgentToken(apiKey, runId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
