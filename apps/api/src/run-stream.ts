import { events, runs } from "@sky/db";
import type { RunId } from "@sky/shared";
import { and, asc, eq, gt } from "drizzle-orm";
import type { Context } from "hono";
import { type SSEMessage, streamSSE } from "hono/streaming";
import type { AppEnv } from "./factory.js";
import { presentEvent, runEvents } from "./run-events.js";
import { isActive } from "./runs.js";

/** One read's frames; `done` ends the stream once they're written, `more` reads again without waiting. */
export type Batch = { frames: SSEMessage[]; done?: boolean; more?: boolean };

/**
 * Streams `read()`'s frames as SSE, reading again after each publish on `channel`, with a `: ping`
 * comment after each `heartbeatMs` of quiet. `read` runs after an await, never inside the publish.
 */
export function tailSSE(
  c: Context<AppEnv>,
  channel: Parameters<typeof runEvents.subscribe>[0],
  read: () => Batch,
  heartbeatMs: number,
  onFail: (err: unknown) => void,
) {
  return streamSSE(c, async (stream) => {
    // set by every publish, so one landing mid-read is never missed
    let dirty = true;
    let wake = () => {};
    const unsubscribe = runEvents.subscribe(channel, () => {
      dirty = true;
      wake();
    });
    stream.onAbort(() => {
      unsubscribe();
      wake();
    });
    try {
      while (!stream.aborted) {
        if (!dirty) {
          let timer: NodeJS.Timeout | undefined;
          const woken = await new Promise<boolean>((resolve) => {
            wake = () => resolve(true);
            timer = setTimeout(() => resolve(false), heartbeatMs);
          });
          clearTimeout(timer);
          if (!woken && !dirty) await stream.write(": ping\n\n");
          continue;
        }
        dirty = false;
        const batch = read();
        for (const frame of batch.frames) await stream.writeSSE(frame);
        if (batch.done) return;
        if (batch.more) dirty = true;
      }
    } catch (err) {
      onFail(err);
    } finally {
      unsubscribe();
    }
  });
}

/**
 * Streams the run's events after row id `after` as SSE, then live-tails until its terminal event,
 * with a `: ping` comment after each `heartbeatMs` of quiet.
 */
export function streamRunEvents(
  c: Context<AppEnv>,
  runId: RunId,
  after: number,
  heartbeatMs: number,
  log: (line: string) => void,
) {
  const db = c.var.db;
  let cursor = after;
  const read = (): Batch => {
    // read together in one tick, so no commit lands between the rows and the status
    const rows = db
      .select()
      .from(events)
      .where(and(eq(events.runId, runId), gt(events.id, cursor)))
      .orderBy(asc(events.id))
      .all();
    const run = db
      .select({ agentId: runs.agentId, status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .get();
    if (!run) return { frames: [], done: true };
    cursor = rows.at(-1)?.id ?? cursor;
    return {
      frames: rows.map((row) => ({
        id: String(row.id),
        event: row.type,
        data: JSON.stringify(presentEvent(row, run.agentId)),
      })),
      // an ended run's terminal event is its last row, so it went out in `rows` or before `after`
      done: !isActive(run.status),
    };
  };
  return tailSSE(c, runId, read, heartbeatMs, (err) =>
    log(`streaming ${runId} failed: ${err}`),
  );
}
