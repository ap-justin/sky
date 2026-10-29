import { randomInt } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A `<prefix>_<22 base62 chars>` id, ~131 bits of randomness, matching the shared id schemas. */
export function mintId<P extends string>(prefix: P): `${P}_${string}` {
  let suffix = "";
  for (let i = 0; i < 22; i++) suffix += BASE62[randomInt(BASE62.length)];
  return `${prefix}_${suffix}`;
}
