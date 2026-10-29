import type { SpritesClient } from "@fly/sprites";
import { agents, environments, runs } from "@harness/db";
import { AgentId, agentBranch, EnvironmentId, RunId } from "@harness/shared";
import { zValidator } from "@hono/zod-validator";
import { and, count, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { apiError } from "./errors.js";
import { factory } from "./factory.js";
import { mintId } from "./ids.js";
import { type Launcher, removeWorktree, signalRunner } from "./launch.js";
import { REPO_DIR } from "./provision.js";
import {
  activeRunOf,
  activeRunStatuses,
  isActive,
  presentRun,
  runError,
  stopActiveRun,
  type Tx,
} from "./runs.js";
import { execInSprite } from "./sprites.js";
import { body, jsonBody } from "./validation.js";

const Prompt = z.string().min(1);
const LaunchInput = z.strictObject({ envId: EnvironmentId, prompt: Prompt });
const FollowUpInput = z.strictObject({ prompt: Prompt });

type AgentRow = typeof agents.$inferSelect;

const presentAgent = (row: AgentRow) => ({
  id: row.id,
  envId: row.envId,
  sessionId: row.sessionId,
  branch: row.branch,
  status: row.status,
  createdAt: row.createdAt,
  archivedAt: row.archivedAt,
});

/** Runs still holding one of the env's concurrency slots. */
const activeRunsIn = (tx: Tx, envId: EnvironmentId) =>
  tx
    .select({ n: count() })
    .from(runs)
    .innerJoin(agents, eq(runs.agentId, agents.id))
    .where(
      and(eq(agents.envId, envId), inArray(runs.status, activeRunStatuses)),
    )
    .get()?.n ?? 0;

const atCap = (c: Context, limit: number) =>
  c.json(
    {
      error: {
        code: "concurrency_cap",
        message: `this environment allows ${limit} active runs`,
        limit,
      },
    },
    409,
  );

const agentWithSprite = (tx: Tx, id: AgentId) =>
  tx
    .select({ agent: agents, spriteName: environments.spriteName })
    .from(agents)
    .innerJoin(environments, eq(agents.envId, environments.id))
    .where(eq(agents.id, id))
    .get();

/** Re-reads an agent this transaction already found. */
const agentRow = (tx: Tx, id: AgentId) => {
  const row = tx.select().from(agents).where(eq(agents.id, id)).get();
  if (!row) throw new Error(`agent ${id} vanished mid-transaction`);
  return row;
};

const archived = (c: Context) =>
  apiError(c, 409, "agent_archived", "the agent is archived");

const agentParam = zValidator(
  "param",
  z.object({ id: AgentId }),
  (result, c) => {
    if (!result.success) return apiError(c, 404, "not_found", "no such agent");
  },
);

const runParam = zValidator(
  "param",
  z.object({ id: AgentId, runId: RunId }),
  (result, c) => {
    if (!result.success) return apiError(c, 404, "not_found", "no such run");
  },
);

export function agentRoutes(
  launcher: Launcher,
  sprites: SpritesClient,
  log: (line: string) => void,
) {
  return factory
    .createApp()
    .post("/", jsonBody, body(LaunchInput), (c) => {
      const { envId, prompt } = c.req.valid("json");
      const agentId = mintId("agt");
      const runId = mintId("run");
      const outcome = c.var.db.transaction(
        (tx) => {
          const env = tx
            .select()
            .from(environments)
            .where(eq(environments.id, envId))
            .get();
          if (!env) return { kind: "not_found" } as const;
          if (env.status !== "ready") return { kind: "not_ready" } as const;
          if (activeRunsIn(tx, envId) >= env.concurrency) {
            return { kind: "at_cap", limit: env.concurrency } as const;
          }
          const agent = tx
            .insert(agents)
            .values({
              id: agentId,
              envId,
              branch: agentBranch(agentId),
              status: "running",
            })
            .returning()
            .get();
          const run = tx
            .insert(runs)
            .values({ id: runId, agentId, status: "starting" })
            .returning()
            .get();
          return { kind: "created", env, agent, run } as const;
        },
        { behavior: "immediate" },
      );
      switch (outcome.kind) {
        case "not_found":
          return apiError(c, 404, "not_found", "no such environment");
        case "not_ready":
          return apiError(
            c,
            409,
            "env_not_ready",
            "environment is not ready; wait for provisioning to succeed",
          );
        case "at_cap":
          return atCap(c, outcome.limit);
      }
      launcher.start({
        spriteName: outcome.env.spriteName,
        agentId,
        runId,
        prompt,
        sessionId: null,
      });
      c.header("Location", `/v1/agents/${agentId}/runs/${runId}`);
      return c.json(
        {
          agent: presentAgent(outcome.agent),
          run: presentRun(outcome.run, null),
        },
        202,
      );
    })
    .post("/:id/runs", agentParam, jsonBody, body(FollowUpInput), (c) => {
      const { id } = c.req.valid("param");
      const { prompt } = c.req.valid("json");
      const runId = mintId("run");
      const outcome = c.var.db.transaction(
        (tx) => {
          const found = tx
            .select({ agent: agents, env: environments })
            .from(agents)
            .innerJoin(environments, eq(agents.envId, environments.id))
            .where(eq(agents.id, id))
            .get();
          if (!found) return { kind: "not_found" } as const;
          const { agent, env } = found;
          if (agent.archivedAt) return { kind: "archived" } as const;
          if (activeRunOf(tx, id)) return { kind: "busy" } as const;
          if (env.status !== "ready") return { kind: "not_ready" } as const;
          if (activeRunsIn(tx, env.id) >= env.concurrency) {
            return { kind: "at_cap", limit: env.concurrency } as const;
          }
          const run = tx
            .insert(runs)
            .values({ id: runId, agentId: id, status: "starting" })
            .returning()
            .get();
          const running = tx
            .update(agents)
            .set({ status: "running" })
            .where(eq(agents.id, id))
            .returning()
            .get();
          return { kind: "created", env, agent: running, run } as const;
        },
        { behavior: "immediate" },
      );
      switch (outcome.kind) {
        case "not_found":
          return apiError(c, 404, "not_found", "no such agent");
        case "archived":
          return archived(c);
        case "busy":
          return apiError(
            c,
            409,
            "agent_busy",
            "the agent already has an active run; wait for it or stop it",
          );
        case "not_ready":
          return apiError(
            c,
            409,
            "env_not_ready",
            "environment is not ready; wait for provisioning to succeed",
          );
        case "at_cap":
          return atCap(c, outcome.limit);
      }
      launcher.start({
        spriteName: outcome.env.spriteName,
        agentId: id,
        runId,
        prompt,
        sessionId: outcome.agent.sessionId,
      });
      c.header("Location", `/v1/agents/${id}/runs/${runId}`);
      return c.json(
        {
          agent: presentAgent(outcome.agent),
          run: presentRun(outcome.run, null),
        },
        202,
      );
    })
    .post("/:id/stop", agentParam, async (c) => {
      const { id } = c.req.valid("param");
      const outcome = c.var.db.transaction(
        (tx) => {
          const found = agentWithSprite(tx, id);
          if (!found) return { kind: "not_found" } as const;
          if (found.agent.archivedAt) return { kind: "archived" } as const;
          const run = stopActiveRun(tx, id);
          return {
            kind: "stopped",
            agent: agentRow(tx, id),
            run,
            spriteName: found.spriteName,
          } as const;
        },
        { behavior: "immediate" },
      );
      switch (outcome.kind) {
        case "not_found":
          return apiError(c, 404, "not_found", "no such agent");
        case "archived":
          return archived(c);
      }
      const { run, spriteName } = outcome;
      // the run is stopped either way: a runner that missed the signal is refused its next post
      if (run) await signalRunner(sprites, spriteName, run.id, log);
      return c.json(
        {
          agent: presentAgent(outcome.agent),
          run: run ? presentRun(run, null) : null,
        },
        200,
      );
    })
    .post("/:id/archive", agentParam, async (c) => {
      const { id } = c.req.valid("param");
      const outcome = c.var.db.transaction(
        (tx) => {
          const found = agentWithSprite(tx, id);
          if (!found) return undefined;
          const run = stopActiveRun(tx, id);
          const agent = found.agent.archivedAt
            ? agentRow(tx, id)
            : tx
                .update(agents)
                .set({ archivedAt: new Date().toISOString() })
                .where(eq(agents.id, id))
                .returning()
                .get();
          return { agent, run, spriteName: found.spriteName };
        },
        { behavior: "immediate" },
      );
      if (!outcome) return apiError(c, 404, "not_found", "no such agent");
      const { agent, run, spriteName } = outcome;
      if (run) await signalRunner(sprites, spriteName, run.id, log);
      try {
        await removeWorktree(sprites, spriteName, id, run?.id ?? null);
      } catch (err) {
        log(`removing the worktree of ${id} failed: ${err}`);
        return apiError(
          c,
          502,
          "worktree_remove_failed",
          "the agent is archived but its worktree could not be removed; retry archive",
        );
      }
      return c.json({ agent: presentAgent(agent) }, 200);
    })
    .get("/:id/runs/:runId", runParam, async (c) => {
      const { id, runId } = c.req.valid("param");
      const db = c.var.db;
      const found = db
        .select({
          run: runs,
          agent: agents,
          spriteName: environments.spriteName,
        })
        .from(runs)
        .innerJoin(agents, eq(runs.agentId, agents.id))
        .innerJoin(environments, eq(agents.envId, environments.id))
        .where(and(eq(runs.id, runId), eq(runs.agentId, id)))
        .get();
      if (!found) return apiError(c, 404, "not_found", "no such run");
      const { run, agent, spriteName } = found;
      // the runner commits at run end, so an active run's branch doesn't hold its work yet
      let diff: string | null = null;
      if (!isActive(run.status)) {
        try {
          const out = await execInSprite(
            sprites,
            spriteName,
            ["git", "diff", `origin/HEAD...${agent.branch}`],
            { cwd: REPO_DIR },
          );
          // nonzero: the runner never created the branch (a launch that failed)
          if (out.exitCode === 0) diff = out.stdout;
        } catch (err) {
          log(`diff of ${run.id} failed: ${err}`);
          return apiError(
            c,
            502,
            "sprite_unreachable",
            "could not read the run's diff from its sprite; retry",
          );
        }
      }
      return c.json(
        {
          ...presentRun(run, runError(db, run.id)),
          branch: agent.branch,
          diff,
        },
        200,
      );
    });
}
