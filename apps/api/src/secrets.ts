import { type Db, environments, secrets } from "@harness/db";
import { EnvironmentId } from "@harness/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { envSecretAad, open, type Sealed, seal } from "./crypto.js";
import { apiError } from "./errors.js";
import { factory } from "./factory.js";
import type { KnownSecrets } from "./redact.js";
import { body, jsonBody } from "./validation.js";

/** Matches the DB's name CHECK on `secrets` and `run_env_vars`. */
export const EnvVarName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

// the runner's own variables, and what would hijack the shell or node that start it
const reservedNames = new Set([
  "AGENT_ID",
  "RUN_ID",
  "API_BASE_URL",
  "AGENT_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "PROMPT",
  "PROMPT_FILE",
  "ENV_FILE",
  "REPO_DIR",
  "WORKTREES_DIR",
  "APPROVAL_POLICY",
  "WAIT_TIMEOUT_MINUTES",
  "SESSION_ID",
  "PATH",
  "HOME",
  "NODE_OPTIONS",
  "IS_SANDBOX",
]);

export const isReservedName = (name: string) => reservedNames.has(name);

export const reservedName = (c: Context, name: string) =>
  apiError(c, 400, "reserved_name", `${name} is reserved for the harness`);

// a value is registered under its own nonce, so one replaced or deleted mid-run stays scrubbed
// from the events of a runner that still holds it
const envSecretKey = (envId: string, name: string, nonce: Buffer) =>
  `${envSecretAad(envId, name)}:${nonce.toString("hex")}`;

const SecretInput = z.union([
  z.strictObject({ value: z.string().min(1) }),
  z.strictObject({ connector: z.string().min(1) }),
]);

type SecretRow = typeof secrets.$inferSelect;

const present = (row: SecretRow) => ({
  name: row.name,
  kind: row.kind,
  ...(row.connector === null ? {} : { connector: row.connector }),
});

const sealedOf = (row: {
  ciphertext: Buffer | null;
  nonce: Buffer | null;
  keyVersion: number | null;
}): Sealed => {
  if (!row.ciphertext || !row.nonce || row.keyVersion === null) {
    throw new Error("a value secret is missing its ciphertext");
  }
  return {
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    keyVersion: row.keyVersion,
  };
};

/** The env's value secrets, decrypted; connector secrets inject nothing. */
export function openEnvSecrets(
  db: Db,
  key: Buffer,
  envId: EnvironmentId,
): Map<string, string> {
  const rows = db
    .select()
    .from(secrets)
    .where(and(eq(secrets.envId, envId), eq(secrets.kind, "value")))
    .all();
  return new Map(
    rows.map((row) => [
      row.name,
      open(key, sealedOf(row), envSecretAad(envId, row.name)),
    ]),
  );
}

/** Registers every stored env value secret with redaction. */
export function registerStoredValues(
  db: Db,
  key: Buffer,
  known: KnownSecrets,
): void {
  const values = db
    .select()
    .from(secrets)
    .where(isNotNull(secrets.ciphertext))
    .all();
  for (const row of values) {
    const sealed = sealedOf(row);
    known.add(
      envSecretKey(row.envId, row.name, sealed.nonce),
      open(key, sealed, envSecretAad(row.envId, row.name)),
    );
  }
}

const notFound = "no such environment";

const envParam = zValidator(
  "param",
  z.object({ id: EnvironmentId }),
  (result, c) => {
    if (!result.success) return apiError(c, 404, "not_found", notFound);
  },
);

const envExists = (db: Db, id: EnvironmentId) =>
  db
    .select({ id: environments.id })
    .from(environments)
    .where(eq(environments.id, id))
    .get() !== undefined;

/** `/:id/secrets`, mounted beside the environment routes. */
export function secretRoutes() {
  return factory
    .createApp()
    .get("/:id/secrets", envParam, (c) => {
      const { id } = c.req.valid("param");
      const db = c.var.db;
      if (!envExists(db, id)) return apiError(c, 404, "not_found", notFound);
      const rows = db
        .select()
        .from(secrets)
        .where(eq(secrets.envId, id))
        .orderBy(asc(secrets.name))
        .all();
      return c.json({ data: rows.map(present) }, 200);
    })
    .put("/:id/secrets/:name", envParam, jsonBody, body(SecretInput), (c) => {
      const { id } = c.req.valid("param");
      const name = c.req.param("name");
      if (!EnvVarName.safeParse(name).success) {
        return apiError(
          c,
          400,
          "invalid_name",
          "a secret name is letters, digits and _, not starting with a digit",
        );
      }
      if (isReservedName(name)) return reservedName(c, name);
      const input = c.req.valid("json");
      const db = c.var.db;
      if (!envExists(db, id)) return apiError(c, 404, "not_found", notFound);
      const sealed =
        "value" in input
          ? seal(
              c.var.config.secretEncryptionKey,
              input.value,
              envSecretAad(id, name),
            )
          : null;
      const fields = sealed
        ? { kind: "value" as const, connector: null, ...sealed }
        : {
            kind: "connector" as const,
            connector: "connector" in input ? input.connector : null,
            ciphertext: null,
            nonce: null,
            keyVersion: null,
          };
      const row = db
        .insert(secrets)
        .values({ envId: id, name, ...fields })
        .onConflictDoUpdate({
          target: [secrets.envId, secrets.name],
          set: fields,
        })
        .returning()
        .get();
      if (sealed && "value" in input) {
        c.var.secrets.add(envSecretKey(id, name, sealed.nonce), input.value);
      }
      return c.json(present(row), 200);
    })
    .delete("/:id/secrets/:name", envParam, (c) => {
      const { id } = c.req.valid("param");
      const deleted = c.var.db
        .delete(secrets)
        .where(
          and(eq(secrets.envId, id), eq(secrets.name, c.req.param("name"))),
        )
        .returning({ name: secrets.name })
        .get();
      if (!deleted) return apiError(c, 404, "not_found", "no such secret");
      return c.body(null, 204);
    });
}
