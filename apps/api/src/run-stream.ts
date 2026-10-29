import { events, runs } from "@harness/db";
import type { RunId } from "@harness/shared";
import { and, asc, eq, gt } from "drizzle-orm";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "./factory.js";
import { presentEvent, runEvents } from "./run-events.js";
import { isActive } from "./runs.js";

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
  return streamSSE(c, async (stream) => {
    let cursor = after;
    // set by every publish, so one landing mid-read is never missed
    let dirty = true;
    let wake = () => {};
    const unsubscribe = runEvents.subscribe(runId, () => {
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
        if (!run) return;
        for (const row of rows) {
          await stream.writeSSE({
            id: String(row.id),
            event: row.type,
            data: JSON.stringify(presentEvent(row, run.agentId)),
          });
          cursor = row.id;
        }
        // an ended run's terminal event is its last row, so it went out in `rows` or before `after`
        if (!isActive(run.status)) return;
      }
    } catch (err) {
      log(`streaming ${runId} failed: ${err}`);
    } finally {
      unsubscribe();
    }
  });
}
