import type { Db } from "@harness/db";
import { createFactory } from "hono/factory";
import type { Config } from "./config.js";

export type AppEnv = { Variables: { db: Db; config: Config } };

/** Sub-apps built from this read `c.var.db` and `c.var.config`, which `createApp` sets. */
export const factory = createFactory<AppEnv>();
