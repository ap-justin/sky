import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// drizzle-kit can't emit STRICT, so `db:generate` runs this over its output; a regenerated
// `__new_<table>` rebuild is a CREATE TABLE too, so a table stays STRICT when it changes shape
const createTable =
  /(CREATE TABLE [^;]*?\n\))(;|\s*--> statement-breakpoint|\s*$)/g;

function addStrict(migrationSql: string): string {
  return migrationSql.replace(createTable, "$1 STRICT$2");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const folder = fileURLToPath(new URL("../drizzle", import.meta.url));
  for (const file of readdirSync(folder).filter((f) => f.endsWith(".sql"))) {
    const path = join(folder, file);
    const before = readFileSync(path, "utf8");
    const after = addStrict(before);
    if (after !== before) writeFileSync(path, after);
  }
}
