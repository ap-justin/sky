import { agents, events, runs } from "@harness/db";
import {
  canTransition,
  type EventType,
  RunnerEventPost,
  type RunStatus,
} from "@harness/shared";
import { eq, inArray } from "drizzle-orm";
import { isAgentTokenFor, mintAgentToken } from "./agent-token.js";
import { enqueueDeliveries } from "./deliveries.js";
import { apiError } from "./errors.js";
import { factory } from "./factory.js";
import { redactDeep } from "./redact.js";
import { activeRunStatuses, agentStatusFor, isActive } from "./runs.js";
import { body, jsonBody } from "./validation.js";

// the status each event moves its run to; progress leaves it where it is
const statusAfter: Record<EventType, RunStatus | null> = {
  "run.started": "running",
  "run.progress": null,
  "run.waiting": "waiting",
  "run.finished": "finished",
  "run.failed": "failed",
  "run.stopped": "stopped",
};

const bearer = (header: string | undefined) =>
  /^Bearer ([A-Za-z0-9_-]+)$/.exec(header ?? "")?.[1];

export function internalRoutes(nudgeDeliveries: () => void) {
  return factory
    .createApp()
    .use("/events", async (c, next) => {
      if (!bearer(c.req.header("authorization"))) {
        return apiError(c, 401, "unauthorized", "missing agent token");
      }
      await next();
    })
    .post("/events", jsonBody, body(RunnerEventPost), (c) => {
      const event = c.req.valid("json");
      const { db, config, secrets } = c.var;
      const token = bearer(c.req.header("authorization")) ?? "";
      const outcome = db.transaction(
        (tx) => {
          const run = tx
            .select()
            .from(runs)
            .where(eq(runs.id, event.runId))
            .get();
          if (!run || !isAgentTokenFor(config.apiKey, event.runId, token)) {
            // a live run's token posting for another run is a runner bug, not a stranger
            const otherRun = tx
              .select({ id: runs.id })
              .from(runs)
              .where(inArray(runs.status, activeRunStatuses))
              .all()
              .some((r) => isAgentTokenFor(config.apiKey, r.id, token));
            return { kind: otherRun ? "forbidden" : "unauthorized" } as const;
          }
          if (!isActive(run.status)) return { kind: "ended" } as const;
          const next = statusAfter[event.type];
          if (next && !canTransition(run.status, next)) {
            return { kind: "illegal", from: run.status, to: next } as const;
          }
          // Claude's output can echo its own environment, or any other live runner's on its sprite
          const liveTokens = tx
            .select({ id: runs.id })
            .from(runs)
            .where(inArray(runs.status, activeRunStatuses))
            .all()
            .map((r) => mintAgentToken(config.apiKey, r.id));
          const redacted = redactDeep(event, [
            ...secrets.values(),
            ...liveTokens,
          ]);
          const ts = new Date().toISOString();
          const { id } = tx
            .insert(events)
            .values({
              runId: run.id,
              ts,
              type: event.type,
              payload: redacted.payload,
            })
            .returning({ id: events.id })
            .get();
          const enqueued = enqueueDeliveries(tx, id, event.type, ts);
          if (next) {
            const usage =
              redacted.type === "run.finished" || redacted.type === "run.failed"
                ? redacted.payload.usage
                : undefined;
            tx.update(runs)
              .set({
                status: next,
                ...(redacted.type === "run.finished"
                  ? { summary: redacted.payload.summary }
                  : {}),
                ...(usage ?? {}),
              })
              .where(eq(runs.id, run.id))
              .run();
          }
          tx.update(agents)
            .set({
              status: agentStatusFor(next ?? run.status),
              ...(event.type === "run.started"
                ? { sessionId: event.payload.sessionId }
                : {}),
            })
            .where(eq(agents.id, run.agentId))
            .run();
          return { kind: "stored", id, enqueued } as const;
        },
        { behavior: "immediate" },
      );
      switch (outcome.kind) {
        case "unauthorized":
          return apiError(c, 401, "unauthorized", "invalid agent token");
        case "forbidden":
          return apiError(c, 403, "forbidden", "token belongs to another run");
        case "ended":
          return apiError(c, 401, "run_ended", "the run has ended");
        case "illegal":
          return apiError(
            c,
            409,
            "invalid_transition",
            `a ${outcome.from} run cannot become ${outcome.to}`,
          );
      }
      // after the commit, so the dispatcher sees the rows; never awaited, so delivery can't slow the runner
      if (outcome.enqueued > 0) nudgeDeliveries();
      return c.json({ id: outcome.id }, 201);
    });
}
