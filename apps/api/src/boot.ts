import { join } from "node:path";
import { SpritesClient } from "@fly/sprites";
import { type Db, migrate, openDb } from "@harness/db";
import { createApp } from "./app.js";
import type { Config } from "./config.js";
import { failInterruptedProvisioning } from "./provision.js";
import { failStaleRuns } from "./runs.js";

const SWEEP_EVERY_MS = 60_000;

/**
 * Opens and migrates the one DB handle the app reuses for its lifetime, fails provisioning a previous
 * process left unfinished, and fails silent runs now and every minute after. Runs outlive a restart:
 * their runners keep posting, so only silence fails one.
 */
export function boot(config: Config, log: (line: string) => void) {
  const db = openDb(join(config.dataDir, "harness.db"));
  migrate(db);
  failInterruptedProvisioning(db);
  const sweep = () => {
    for (const id of failStaleRuns(db, config.runTimeoutMs)) {
      log(`run ${id} failed: runner_timeout`);
    }
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
  return {
    db,
    app: createApp({ db, config, sprites, log }),
    stopSweeping: () => clearInterval(sweeper),
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
