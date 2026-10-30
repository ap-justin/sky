import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  type BetterSQLite3Database,
  drizzle,
} from "drizzle-orm/better-sqlite3";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import * as schema from "./schema.js";

export * from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema> & {
  $client: Database.Database;
};

/** Opens the one writer connection; drizzle sets no pragmas, so they go on the raw handle here. */
export function openDb(path: string): Db {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = NORMAL");
  return drizzle(sqlite, { schema });
}

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

// drizzle applies only migrations newer than the file's last recorded one, so a file a newer
// build migrated looks up to date to older code; stop rather than query a schema it doesn't know
function refuseNewerFile(sqlite: Database.Database): void {
  const tracked = sqlite
    .prepare(
      "select 1 from sqlite_schema where type = 'table' and name = '__drizzle_migrations'",
    )
    .get();
  if (!tracked) return;
  const last = sqlite
    .prepare("select max(created_at) as at from __drizzle_migrations")
    .get() as { at: number | null };
  const known = Math.max(
    ...readMigrationFiles({ migrationsFolder }).map((m) => m.folderMillis),
  );
  if (last.at !== null && Number(last.at) > known) {
    throw new Error(
      "database was migrated by a newer version of sky; refusing to open it with this one",
    );
  }
}

/** Applies pending migrations; call once at boot, before serving. */
export function migrate(db: Db): void {
  const sqlite = db.$client;
  refuseNewerFile(sqlite);
  // drizzle runs each file inside BEGIN, where `foreign_keys` is a no-op, so a generated
  // table rebuild's DROP TABLE would cascade into child rows; switch FKs off around it instead
  sqlite.pragma("foreign_keys = OFF");
  try {
    drizzleMigrate(db, { migrationsFolder });
    const violations = sqlite.pragma("foreign_key_check");
    if (Array.isArray(violations) && violations.length > 0) {
      throw new Error(
        `migration left foreign key violations: ${JSON.stringify(violations)}`,
      );
    }
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }
}
