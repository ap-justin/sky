import type { Db } from "@harness/db";
import { createFactory } from "hono/factory";
import type { Config } from "./config.js";
import type { KnownSecrets } from "./redact.js";

export type AppEnv = {
  Variables: { db: Db; config: Config; secrets: KnownSecrets };
};

/** Sub-apps built from this read `c.var.db`, `c.var.config` and `c.var.secrets`, which `createApp` sets. */
export const factory = createFactory<AppEnv>();
