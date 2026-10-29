import { agents, type Db, events, runs } from "@harness/db";
import {
  type AgentId,
  type AgentStatus,
  type RunId,
  RunStatus,
  runTransitions,
} from "@harness/shared";
import { and, eq, inArray, sql } from "drizzle-orm";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type RunRow = typeof runs.$inferSelect;

export const activeRunStatuses = RunStatus.options.filter(
  (s) => runTransitions[s].length > 0,
);

export const isActive = (status: RunStatus) =>
  activeRunStatuses.includes(status);

/** The agent's status while its latest run is in `status`. */
export const agentStatusFor = (status: RunStatus): AgentStatus =>
  status === "waiting" ? "waiting" : isActive(status) ? "running" : "idle";

export const presentRun = (row: RunRow, error: string | null) => ({
  id: row.id,
  agentId: row.agentId,
  status: row.status,
  summary: row.summary,
  usage:
    row.inputTokens === null ||
    row.outputTokens === null ||
    row.costUsd === null ||
    row.turns === null ||
    row.durationMs === null
      ? null
      : {
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          costUsd: row.costUsd,
          turns: row.turns,
          durationMs: row.durationMs,
        },
  error,
  createdAt: row.createdAt,
});

/** The agent's run that hasn't ended, if any; an agent has at most one. */
export const activeRunOf = (tx: Db | Tx, agentId: AgentId) =>
  tx
    .select()
    .from(runs)
    .where(
      and(eq(runs.agentId, agentId), inArray(runs.status, activeRunStatuses)),
    )
    .get();

/** The error of the run's `run.failed` event; null for a run that hasn't failed. */
export function runError(tx: Db | Tx, runId: RunId): string | null {
  const row = tx
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.runId, runId), eq(events.type, "run.failed")))
    .get();
  return row ? (row.payload as { error: string }).error : null;
}

/** Ends a still-active run as `status`, recording `payload` as its event; the ended row, or undefined on an ended run. */
function endRun(
  tx: Tx,
  runId: RunId,
  status: "failed" | "stopped",
  payload: object,
): RunRow | undefined {
  const run = tx.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run || !isActive(run.status)) return undefined;
  const ended = tx
    .update(runs)
    .set({ status })
    .where(eq(runs.id, runId))
    .returning()
    .get();
  tx.insert(events)
    .values({
      runId,
      ts: new Date().toISOString(),
      type: status === "failed" ? "run.failed" : "run.stopped",
      payload,
    })
    .run();
  tx.update(agents)
    .set({ status: "idle" })
    .where(eq(agents.id, run.agentId))
    .run();
  return ended;
}

/** Fails a still-active run with `error`, recording it as the run's `run.failed` event; no-op on an ended run. */
export function failRun(tx: Tx, runId: RunId, error: string): void {
  endRun(tx, runId, "failed", { error });
}

/** Stops the agent's active run, recording a `run.stopped` event; the stopped run, or undefined when none was active. */
export function stopActiveRun(tx: Tx, agentId: AgentId): RunRow | undefined {
  const run = activeRunOf(tx, agentId);
  return run && endRun(tx, run.id, "stopped", {});
}

/**
 * Fails every active run with no event (or, before its first, no launch) since `timeoutMs` ago, so a
 * runner that died can't hold a concurrency slot. Returns the ids it failed.
 */
export function failStaleRuns(db: Db, timeoutMs: number, now = Date.now()) {
  const cutoff = new Date(now - timeoutMs).toISOString();
  const lastActivity = sql<string>`coalesce((select max(${events.ts}) from ${events} where ${events.runId} = ${runs.id}), ${runs.createdAt})`;
  // one write transaction, so an event landing mid-sweep can't be overtaken by a stale read
  return db.transaction(
    (tx) => {
      const stale = tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            inArray(runs.status, activeRunStatuses),
            sql`${lastActivity} < ${cutoff}`,
          ),
        )
        .all()
        .map((r) => r.id);
      for (const id of stale) failRun(tx, id, "runner_timeout");
      return stale;
    },
    { behavior: "immediate" },
  );
}
