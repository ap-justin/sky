import type { SpritesClient } from "@fly/sprites";
import { agents, environments, runs } from "@harness/db";
import { AgentId, agentBranch, EnvironmentId, RunId } from "@harness/shared";
import { zValidator } from "@hono/zod-validator";
import { and, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { apiError } from "./errors.js";
import { factory } from "./factory.js";
import { mintId } from "./ids.js";
import type { Launcher } from "./launch.js";
import { REPO_DIR } from "./provision.js";
import { activeRunStatuses, isActive, presentRun, runError } from "./runs.js";
import { execInSprite } from "./sprites.js";
import { body, jsonBody } from "./validation.js";

const LaunchInput = z.strictObject({
  envId: EnvironmentId,
  prompt: z.string().min(1),
});

type AgentRow = typeof agents.$inferSelect;

const presentAgent = (row: AgentRow) => ({
  id: row.id,
  envId: row.envId,
  sessionId: row.sessionId,
  branch: row.branch,
  status: row.status,
  createdAt: row.createdAt,
});

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
          const active =
            tx
              .select({ n: count() })
              .from(runs)
              .innerJoin(agents, eq(runs.agentId, agents.id))
              .where(
                and(
                  eq(agents.envId, envId),
                  inArray(runs.status, activeRunStatuses),
                ),
              )
              .get()?.n ?? 0;
          if (active >= env.concurrency) {
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
          return c.json(
            {
              error: {
                code: "concurrency_cap",
                message: `this environment allows ${outcome.limit} active runs`,
                limit: outcome.limit,
              },
            },
            409,
          );
      }
      launcher.start({
        spriteName: outcome.env.spriteName,
        agentId,
        runId,
        prompt,
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
