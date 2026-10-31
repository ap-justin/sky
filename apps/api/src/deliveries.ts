import { createHmac } from "node:crypto";
import { type Db, events, runs, webhookDeliveries, webhooks } from "@sky/db";
import type { AgentId, EventType } from "@sky/shared";
import { and, asc, eq, lt, lte, ne } from "drizzle-orm";
import { presentEvent } from "./run-events.js";
import type { Tx } from "./runs.js";

const TICK_MS = 5_000;
const BATCH = 20;
const TIMEOUT_MS = 30_000;
// 10 s doubling to the 1 h cap spans about a day over 30 attempts; a delivery held behind its
// webhook's 429 spends none, so a rate-limited receiver doesn't burn the queue behind it
const MAX_ATTEMPTS = 30;
const FIRST_RETRY_MS = 10_000;
const MAX_RETRY_MS = 3_600_000;
// the CHECK on webhook_deliveries.last_error
const MAX_ERROR_LENGTH = 1000;

/**
 * The `Sky-Signature` header for one delivery: `t=<unix seconds>,v1=<hex>`, where hex is
 * HMAC-SHA256 keyed with the UTF-8 bytes of `key` over `<t>.<raw body>`. A receiver recomputes it
 * over the exact bytes it received and rejects a `t` too far from its own clock.
 */
export function signatureHeader(key: string, body: string, t: number): string {
  const v1 = createHmac("sha256", key).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

/** Backoff before the next try after `attempts` failures: 10s doubling to a 1h cap, ±20% by `random` in [0, 1). */
export function retryDelayMs(attempts: number, random: number): number {
  const base = Math.min(FIRST_RETRY_MS * 2 ** (attempts - 1), MAX_RETRY_MS);
  return base * (0.8 + 0.4 * random);
}

/**
 * The wait a 429's `Retry-After` asks for, as delta-seconds or an HTTP-date measured from `now`,
 * clamped to [5 s, 1 h]; null when absent or unparseable. The floor is the drain tick: a shorter
 * wait comes due again within the same drain, and a receiver answering 0 would spend every attempt
 * in a second.
 */
export function retryAfterMs(header: string | null, now: Date): number | null {
  if (header === null) return null;
  const value = header.trim();
  const ms = /^\d+$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - now.getTime();
  if (Number.isNaN(ms)) return null;
  return Math.min(Math.max(ms, TICK_MS), MAX_RETRY_MS);
}

/** Enqueues one pending delivery per subscription to `type`, in the transaction that stored the event. */
export function enqueueDeliveries(
  tx: Tx,
  eventId: number,
  type: EventType,
  at: string,
): number {
  const subscribers = tx
    .select({ id: webhooks.id, eventTypes: webhooks.eventTypes })
    .from(webhooks)
    .all()
    .filter((w) => w.eventTypes.includes(type));
  if (subscribers.length === 0) return 0;
  tx.insert(webhookDeliveries)
    .values(
      subscribers.map((w) => ({
        webhookId: w.id,
        eventId,
        status: "pending" as const,
        nextAttemptAt: at,
      })),
    )
    .onConflictDoNothing({
      target: [webhookDeliveries.webhookId, webhookDeliveries.eventId],
    })
    .run();
  return subscribers.length;
}

const describeError = (err: unknown): string => {
  if (err instanceof Error && err.name === "TimeoutError") {
    return `timed out after ${TIMEOUT_MS / 1000}s`;
  }
  // fetch's own message is a bare "fetch failed"; the cause says why
  const cause = err instanceof Error ? err.cause : undefined;
  const text = cause instanceof Error ? `${err}: ${cause.message}` : `${err}`;
  return text.slice(0, MAX_ERROR_LENGTH);
};

export type Dispatcher = ReturnType<typeof createDispatcher>;

/**
 * Sends due webhook deliveries from the DB, one drain at a time: a 2xx delivers, anything else (a
 * redirect included, never followed) retries with backoff until the 30th attempt fails it. A 429
 * retries after its `Retry-After` when it parses (capped at 1 h), and holds every other pending
 * delivery of that webhook until then without spending their attempts. Each failed attempt logs
 * one line; the one that gives up is prefixed `warn:`.
 */
export function createDispatcher({
  db,
  signingKey,
  log,
  now = () => new Date(),
  random = Math.random,
}: {
  db: Db;
  signingKey: string;
  log: (line: string) => void;
  now?: () => Date;
  random?: () => number;
}) {
  const stopping = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let inflight: Promise<void> | null = null;
  let again = false;

  type Due = {
    id: number;
    webhookId: (typeof webhookDeliveries.$inferSelect)["webhookId"];
    attempts: number;
    url: string;
    agentId: AgentId;
    event: typeof events.$inferSelect;
  };

  async function attempt(row: Due): Promise<void> {
    const { event } = row;
    const id = `evt_${event.id}` as const;
    const body = JSON.stringify(presentEvent(event, row.agentId));
    const t = Math.floor(now().getTime() / 1000);
    let status: number | null = null;
    let error: string | null = null;
    let retryAfter: number | null = null;
    try {
      const res = await fetch(row.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Sky-Event-Id": id,
          "Sky-Event-Type": event.type,
          "Sky-Signature": signatureHeader(signingKey, body, t),
        },
        body,
        redirect: "manual",
        signal: AbortSignal.any([
          AbortSignal.timeout(TIMEOUT_MS),
          stopping.signal,
        ]),
      });
      status = res.status;
      if (status === 429) {
        retryAfter = retryAfterMs(res.headers.get("retry-after"), now());
      }
      await res.body?.cancel();
    } catch (err) {
      // cut off by shutdown: the attempt doesn't count, and the row resumes at the next boot
      if (stopping.signal.aborted) return;
      error = describeError(err);
    }
    const attempts = row.attempts + 1;
    const delivered = status !== null && status >= 200 && status < 300;
    const failed = !delivered && attempts >= MAX_ATTEMPTS;
    const nextAttemptAt =
      delivered || failed
        ? undefined
        : new Date(
            now().getTime() + (retryAfter ?? retryDelayMs(attempts, random())),
          ).toISOString();
    const holdUntil = status === 429 ? nextAttemptAt : undefined;
    db.transaction((tx) => {
      tx.update(webhookDeliveries)
        .set({
          status: delivered ? "delivered" : failed ? "failed" : "pending",
          attempts,
          lastStatus: status,
          lastError: error,
          ...(nextAttemptAt ? { nextAttemptAt } : {}),
        })
        .where(eq(webhookDeliveries.id, row.id))
        .run();
      if (!holdUntil) return;
      tx.update(webhookDeliveries)
        .set({ nextAttemptAt: holdUntil })
        .where(
          and(
            eq(webhookDeliveries.webhookId, row.webhookId),
            eq(webhookDeliveries.status, "pending"),
            ne(webhookDeliveries.id, row.id),
            lt(webhookDeliveries.nextAttemptAt, holdUntil),
          ),
        )
        .run();
    });
    if (delivered) return;
    const outcome = status === null ? error : `status ${status}`;
    const held = holdUntil ? `; webhook held until ${holdUntil}` : "";
    const line = `webhook ${row.webhookId} ${id}: attempt ${attempts}/${MAX_ATTEMPTS} failed: ${outcome}${held}`;
    log(failed ? `warn: ${line}; giving up` : line);
  }

  /** Sends one batch of due deliveries; true when the batch was full, so more may be due. */
  async function sendBatch(): Promise<boolean> {
    const due = db
      .select({
        id: webhookDeliveries.id,
        webhookId: webhookDeliveries.webhookId,
        attempts: webhookDeliveries.attempts,
        url: webhooks.url,
        agentId: runs.agentId,
        event: events,
      })
      .from(webhookDeliveries)
      .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
      .innerJoin(events, eq(webhookDeliveries.eventId, events.id))
      .innerJoin(runs, eq(events.runId, runs.id))
      .where(
        and(
          eq(webhookDeliveries.status, "pending"),
          lte(webhookDeliveries.nextAttemptAt, now().toISOString()),
        ),
      )
      .orderBy(asc(webhookDeliveries.nextAttemptAt), asc(webhookDeliveries.id))
      .limit(BATCH)
      .all();
    await Promise.all(due.map(attempt));
    return due.length === BATCH;
  }

  /** Sends every due delivery; a call during a drain joins it and makes it look again before resolving. */
  function drain(): Promise<void> {
    if (stopping.signal.aborted) return Promise.resolve();
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = (async () => {
      try {
        do {
          again = false;
          if (await sendBatch()) again = true;
        } while (again && !stopping.signal.aborted);
      } catch (err) {
        log(`delivering webhooks failed: ${err}`);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  const nudge = () => {
    void drain();
  };

  return {
    drain,
    nudge,
    /** Drains now, then every 5 s. */
    start() {
      timer = setInterval(nudge, TICK_MS);
      timer.unref();
      nudge();
    },
    /** Stops ticking and aborts in-flight sends; resolves once the drain has written its last row. */
    stop(): Promise<void> {
      clearInterval(timer);
      stopping.abort();
      return inflight ?? Promise.resolve();
    },
  };
}
