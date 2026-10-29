import { join } from "node:path";
import { SpritesClient } from "@fly/sprites";
import { type Db, migrate, openDb } from "@harness/db";
import { createApp } from "./app.js";
import type { Config } from "./config.js";
import { createDispatcher } from "./deliveries.js";
import { failInterruptedProvisioning } from "./provision.js";
import { KnownSecrets } from "./redact.js";
import { failAbandonedWaits, failStaleRuns } from "./runs.js";
import { purgeExpiredEnvVars } from "./secrets.js";

const SWEEP_EVERY_MS = 60_000;

/**
 * Opens and migrates the one DB handle the app reuses for its lifetime, fails provisioning a previous
 * process left unfinished, and fails silent runs and abandoned waits now and every minute after. Runs
 * outlive a restart: their runners keep posting, so only silence fails one. The same sweep deletes
 * run envVars past their TTL. Webhook deliveries left pending resume at once.
 */
export function boot(config: Config, log: (line: string) => void) {
  const db = openDb(join(config.dataDir, "harness.db"));
  migrate(db);
  failInterruptedProvisioning(db);
  const dispatcher = createDispatcher({
    db,
    signingKey: config.webhookSigningKey,
    log,
  });
  // the app redacts with it; the sweep drops each envVar it purges
  const secrets = KnownSecrets.fromConfig(config);
  const sweep = () => {
    purgeExpiredEnvVars(db, secrets, new Date());
    const stale = failStaleRuns(db, config.runTimeoutMs);
    for (const id of stale) log(`run ${id} failed: runner_timeout`);
    const abandoned = failAbandonedWaits(db, config.waitTimeoutMs);
    for (const id of abandoned) log(`run ${id} failed: waiting_timeout`);
    if (stale.length + abandoned.length > 0) dispatcher.nudge();
  };
  sweep();
  const sweeper = setInterval(
    () => {
      try {
        sweep();
      } catch (err) {
        log(`sweeping stale runs failed: ${err}`);
      }
    },
    Math.min(SWEEP_EVERY_MS, config.runTimeoutMs),
  );
  sweeper.unref();
  const sprites = new SpritesClient(config.spritesToken);
  dispatcher.start();
  return {
    db,
    app: createApp({
      db,
      config,
      sprites,
      log,
      nudgeDeliveries: dispatcher.nudge,
      secrets,
    }),
    stopSweeping: () => clearInterval(sweeper),
    stopDelivering: dispatcher.stop,
  };
}

type Closable = { close(done: (err?: Error) => void): unknown };

/** Stops accepting requests and lets in-flight ones finish before the DB goes away. */
export async function shutdown(server: Closable, db: Db): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  } finally {
    db.$client.close();
  }
}
