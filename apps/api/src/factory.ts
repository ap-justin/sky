import type { Db } from "@harness/db";
import { createFactory } from "hono/factory";
import type { Config } from "./config.js";
import type { KnownSecrets } from "./redact.js";

export type AppEnv = {
  Variables: {
    db: Db;
    config: Config;
    secrets: KnownSecrets;
    /** Wakes the delivery loop; call after the transaction that enqueued deliveries commits. */
    nudgeDeliveries: () => void;
  };
};

/** Sub-apps built from this read the `c.var` fields above, which `createApp` sets. */
export const factory = createFactory<AppEnv>();
