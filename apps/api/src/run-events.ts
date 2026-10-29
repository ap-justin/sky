import { EventEmitter } from "node:events";
import type { events } from "@harness/db";
import type { AgentId, Event, RunId } from "@harness/shared";

const emitter = new EventEmitter().setMaxListeners(0);

/**
 * In-process wake-ups for a run's new event rows. A publish carries no event: listeners re-read the
 * table, so it is safe to publish inside the inserting transaction. better-sqlite3 commits before any
 * awaited continuation runs, and a rolled-back insert just reads as nothing new. A listener must not
 * read the DB synchronously, or it sees the uncommitted row on the shared connection.
 */
export const runEvents = {
  publish(runId: RunId): void {
    emitter.emit(runId);
  },
  /** Calls `listener` after each publish for `runId`; returns the unsubscribe. */
  subscribe(runId: RunId, listener: () => void): () => void {
    emitter.on(runId, listener);
    return () => emitter.off(runId, listener);
  },
  listenerCount: (runId: RunId) => emitter.listenerCount(runId),
};

/** The shared Event shape webhooks and the run stream send for a stored row of `agentId`'s run. */
export const presentEvent = (
  row: typeof events.$inferSelect,
  agentId: AgentId,
): Event =>
  ({
    id: `evt_${row.id}`,
    agentId,
    runId: row.runId,
    ts: row.ts,
    type: row.type,
    payload: row.payload,
  }) as Event;
