import type { SpritesClient } from "@fly/sprites";
import { agents, type Db, environments, events, runs } from "@harness/db";
import {
  Environment,
  EnvironmentId,
  RunStatus,
  runTransitions,
} from "@harness/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { apiError } from "./errors.js";
import { factory } from "./factory.js";
import { mintId } from "./ids.js";
import type { Provisioner } from "./provision.js";
import { destroySprite, spriteNameFor } from "./sprites.js";

const { name, repo, setup, concurrency, approvalPolicy } = Environment.shape;
const EnvironmentInput = z.strictObject({
  name,
  repo,
  setup,
  concurrency,
  approvalPolicy,
});
// unwrapped: zod 4 applies a default even inside .optional(), which would reset omitted fields
const EnvironmentPatch = z.strictObject({
  name: name.optional(),
  repo: repo.optional(),
  setup: setup.optional(),
  concurrency: concurrency.unwrap().optional(),
  approvalPolicy: approvalPolicy.unwrap().optional(),
});

const activeRunStatuses = RunStatus.options.filter(
  (s) => runTransitions[s].length > 0,
);

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type EnvRow = typeof environments.$inferSelect;

const findEnv = (tx: Db | Tx, id: EnvironmentId) =>
  tx.select().from(environments).where(eq(environments.id, id)).get();

const nameTaken = (tx: Tx, envName: string) =>
  tx
    .select({ id: environments.id })
    .from(environments)
    .where(eq(environments.name, envName))
    .get() !== undefined;

const hasActiveRun = (tx: Db | Tx, id: EnvironmentId) =>
  tx
    .select({ id: runs.id })
    .from(runs)
    .innerJoin(agents, eq(runs.agentId, agents.id))
    .where(and(eq(agents.envId, id), inArray(runs.status, activeRunStatuses)))
    .get() !== undefined;

// validators read the body only under a JSON content type, so anything else would validate as {}
const jsonBody = factory.createMiddleware(async (c, next) => {
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/(?:[\w.-]+\+)?json\b/i.test(type)) {
    return apiError(c, 415, "unsupported_media_type", "send application/json");
  }
  try {
    await c.req.json();
  } catch {
    return apiError(c, 400, "invalid_json", "request body is not valid JSON");
  }
  await next();
});

const body = <T extends z.ZodType>(schema: T) =>
  zValidator("json", schema, (result, c) => {
    if (!result.success) {
      return apiError(c, 400, "invalid_body", z.prettifyError(result.error));
    }
  });

const notFound = "no such environment";
const runActive = "a run on this environment is active";
const nameTakenMessage = "an environment with this name exists";
const stillProvisioning = "environment is still provisioning";

const envParam = zValidator(
  "param",
  z.object({ id: EnvironmentId }),
  (result, c) => {
    if (!result.success) {
      return apiError(c, 404, "not_found", notFound);
    }
  },
);

export function environmentRoutes(
  provisioner: Provisioner,
  sprites: SpritesClient,
  log: (line: string) => void,
) {
  const present = (row: EnvRow) => ({
    ...row,
    failure: row.status === "failed" ? provisioner.failureOf(row.id) : null,
  });

  return factory
    .createApp()
    .get("/", (c) => {
      const rows = c.var.db
        .select()
        .from(environments)
        .orderBy(asc(environments.name))
        .all();
      return c.json({ data: rows.map(present) }, 200);
    })
    .post("/", jsonBody, body(EnvironmentInput), (c) => {
      const input = c.req.valid("json");
      const id = mintId("env");
      const row = c.var.db.transaction(
        (tx) => {
          if (nameTaken(tx, input.name)) return undefined;
          return tx
            .insert(environments)
            .values({
              ...input,
              id,
              status: "provisioning",
              spriteName: spriteNameFor(id),
              checkpointId: null,
            })
            .returning()
            .get();
        },
        { behavior: "immediate" },
      );
      if (!row) {
        return apiError(c, 409, "name_taken", nameTakenMessage);
      }
      provisioner.start(row, { fresh: true });
      c.header("Location", `/v1/environments/${id}`);
      return c.json(present(row), 202);
    })
    .get("/:id", envParam, (c) => {
      const row = findEnv(c.var.db, c.req.valid("param").id);
      if (!row) return apiError(c, 404, "not_found", notFound);
      return c.json(present(row), 200);
    })
    .patch("/:id", envParam, jsonBody, body(EnvironmentPatch), (c) => {
      const { id } = c.req.valid("param");
      const patch = c.req.valid("json");
      const outcome = c.var.db.transaction(
        (tx) => {
          const env = findEnv(tx, id);
          if (!env) return { kind: "not_found" } as const;
          if (hasActiveRun(tx, id)) return { kind: "run_active" } as const;
          const reprovision =
            (patch.repo !== undefined && patch.repo !== env.repo) ||
            (patch.setup !== undefined && patch.setup !== env.setup);
          if (reprovision && env.status === "provisioning") {
            return { kind: "provisioning" } as const;
          }
          if (
            patch.name !== undefined &&
            patch.name !== env.name &&
            nameTaken(tx, patch.name)
          ) {
            return { kind: "name_taken" } as const;
          }
          // a sprite whose creation failed doesn't exist, so the rerun starts by creating it
          const fresh =
            env.status === "failed" &&
            provisioner.failureOf(id)?.step === "create";
          const changes = reprovision
            ? { ...patch, status: "provisioning" as const, checkpointId: null }
            : patch;
          // drizzle refuses an update with nothing to set
          const row =
            Object.keys(changes).length === 0
              ? env
              : tx
                  .update(environments)
                  .set(changes)
                  .where(eq(environments.id, id))
                  .returning()
                  .get();
          return { kind: "updated", row, reprovision, fresh } as const;
        },
        { behavior: "immediate" },
      );
      switch (outcome.kind) {
        case "not_found":
          return apiError(c, 404, "not_found", notFound);
        case "run_active":
          return apiError(c, 409, "run_active", runActive);
        case "provisioning":
          return apiError(c, 409, "provisioning", stillProvisioning);
        case "name_taken":
          return apiError(c, 409, "name_taken", nameTakenMessage);
      }
      if (outcome.reprovision) {
        provisioner.start(outcome.row, { fresh: outcome.fresh });
        return c.json(present(outcome.row), 202);
      }
      return c.json(present(outcome.row), 200);
    })
    .delete("/:id", envParam, async (c) => {
      const { id } = c.req.valid("param");
      const db = c.var.db;
      const env = findEnv(db, id);
      if (!env) return apiError(c, 404, "not_found", notFound);
      if (hasActiveRun(db, id)) {
        return apiError(c, 409, "run_active", runActive);
      }
      if (env.status === "provisioning") {
        return apiError(c, 409, "provisioning", stillProvisioning);
      }
      try {
        await destroySprite(sprites, env.spriteName);
      } catch (err) {
        log(`destroying sprite ${env.spriteName} failed: ${err}`);
        return apiError(
          c,
          502,
          "sprite_destroy_failed",
          "could not destroy the environment's sprite; retry the delete",
        );
      }
      db.transaction(
        (tx) => {
          const envAgents = tx
            .select({ id: agents.id })
            .from(agents)
            .where(eq(agents.envId, id));
          const envRuns = tx
            .select({ id: runs.id })
            .from(runs)
            .where(inArray(runs.agentId, envAgents));
          tx.delete(events).where(inArray(events.runId, envRuns)).run();
          tx.delete(runs).where(inArray(runs.agentId, envAgents)).run();
          tx.delete(agents).where(eq(agents.envId, id)).run();
          tx.delete(environments).where(eq(environments.id, id)).run();
        },
        { behavior: "immediate" },
      );
      provisioner.forget(id);
      return c.body(null, 204);
    });
}
