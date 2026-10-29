import { join } from "node:path";
import { SpritesClient } from "@fly/sprites";
import { type Db, migrate, openDb } from "@harness/db";
import { createApp } from "./app.js";
import type { Config } from "./config.js";
import { failInterruptedProvisioning } from "./provision.js";

/** Opens and migrates the one DB handle the app reuses for its lifetime, then fails provisioning a previous process left unfinished. */
export function boot(config: Config, log: (line: string) => void) {
  const db = openDb(join(config.dataDir, "harness.db"));
  migrate(db);
  failInterruptedProvisioning(db);
  const sprites = new SpritesClient(config.spritesToken);
  return { db, app: createApp({ db, config, sprites, log }) };
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
