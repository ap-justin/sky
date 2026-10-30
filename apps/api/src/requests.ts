import { EventEmitter } from "node:events";
import { agents, type Db, runRequests, runs } from "@sky/db";
import type {
  AgentId,
  Decision,
  PendingRequest,
  RequestId,
  RunId,
} from "@sky/shared";
import { and, eq, isNull } from "drizzle-orm";
import { recordEvent, type Tx } from "./runs.js";

const emitter = new EventEmitter().setMaxListeners(0);

/**
 * In-process wake-ups for a request's decision. Publish only after the deciding transaction commits:
 * a listener re-reads the row at once.
 */
export const requestDecisions = {
  publish(requestId: RequestId): void {
    emitter.emit(requestId);
  },
  /** Calls `listener` after each publish for `requestId`; returns the unsubscribe. */
  subscribe(requestId: RequestId, listener: () => void): () => void {
    emitter.on(requestId, listener);
    return () => emitter.off(requestId, listener);
  },
};

/** The run's undecided request, if any; a run has at most one. */
export const openRequestOf = (tx: Db | Tx, runId: RunId) =>
  tx
    .select({ request: runRequests.request })
    .from(runRequests)
    .where(and(eq(runRequests.runId, runId), isNull(runRequests.decidedAt)))
    .get();

/** Stores the run's pending request; the caller has checked it has none open. */
export function openRequest(tx: Tx, runId: RunId, request: PendingRequest) {
  tx.insert(runRequests)
    .values({ id: request.requestId, runId, kind: request.kind, request })
    .run();
}

const resumedAs = {
  answer: "answered",
  approve: "approved",
  deny: "denied",
} as const;

/**
 * Records `decision` on its request, if it is open on the agent's waiting run, and moves the run and
 * agent back to `running`. Publish the request's decision once `tx` commits.
 */
export function decideRequest(tx: Tx, agentId: AgentId, decision: Decision) {
  const found = tx
    .select({ request: runRequests, run: runs })
    .from(runRequests)
    .innerJoin(runs, eq(runRequests.runId, runs.id))
    .where(
      and(eq(runRequests.id, decision.requestId), eq(runs.agentId, agentId)),
    )
    .get();
  if (!found) return { kind: "not_found" } as const;
  const wanted = decision.decision === "answer" ? "question" : "approval";
  if (found.request.kind !== wanted) {
    return { kind: "wrong_kind", requestKind: found.request.kind } as const;
  }
  if (found.run.status !== "waiting") return { kind: "closed" } as const;
  // the decided_at guard makes a concurrent second decision a no-op
  const { changes } = tx
    .update(runRequests)
    .set({ decision, decidedAt: new Date().toISOString() })
    .where(
      and(
        eq(runRequests.id, decision.requestId),
        isNull(runRequests.decidedAt),
      ),
    )
    .run();
  if (changes === 0) return { kind: "closed" } as const;
  const run = tx
    .update(runs)
    .set({ status: "running" })
    .where(eq(runs.id, found.run.id))
    .returning()
    .get();
  tx.update(agents)
    .set({ status: "running" })
    .where(eq(agents.id, agentId))
    .run();
  const { enqueued } = recordEvent(tx, run.id, "run.resumed", {
    requestId: decision.requestId,
    decision: resumedAs[decision.decision],
  });
  return { kind: "decided", run, enqueued } as const;
}
