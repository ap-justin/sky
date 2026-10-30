import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AgentId,
  Environment,
  EnvironmentId,
  RequestId,
  RunId,
} from "@sky/shared";
import { z } from "zod";

export type Fetch = (request: Request) => Response | Promise<Response>;

export interface McpHandlerOptions {
  /** Origin (plus any path prefix) that serves `/v1`. */
  baseUrl: string;
  /** Sends each `/v1` request; defaults to the global `fetch`. */
  fetch?: Fetch;
  /** Bearer key every `/v1` call carries. */
  apiKey: string;
}

const HandlerOptions = z.object({
  baseUrl: z.url({ protocol: /^https?$/ }),
  apiKey: z.string().min(1),
});

type Outcome =
  | { ok: true; value: unknown }
  | { ok: false; result: CallToolResult };

type Call = (
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) => Promise<Outcome>;

const text = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  ...(isError && { isError }),
});

const ErrorEnvelope = z.object({
  error: z.looseObject({ code: z.string(), message: z.string() }),
});

const failure = (status: number, code: string, message: string) =>
  text({ status, error: { code, message } }, true);

const parseJson = (raw: string) => {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown } as const;
  } catch {
    return { ok: false } as const;
  }
};

function apiClient({
  baseUrl,
  apiKey,
  fetch: send = fetch,
}: McpHandlerOptions): Call {
  const base = baseUrl.replace(/\/+$/, "");
  return async (method, path, body) => {
    let res: Response;
    try {
      res = await send(
        new Request(`${base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${apiKey}`,
            ...(body !== undefined && { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    } catch (err) {
      return { ok: false, result: failure(0, "api_unreachable", String(err)) };
    }
    const raw = await res.text();
    const parsed = parseJson(raw);
    if (res.ok) return { ok: true, value: parsed.ok ? parsed.value : raw };
    const envelope = ErrorEnvelope.safeParse(parsed.ok ? parsed.value : null);
    return {
      ok: false,
      result: envelope.success
        ? text({ status: res.status, error: envelope.data.error }, true)
        : failure(res.status, `http_${res.status}`, raw || res.statusText),
    };
  };
}

const { name, repo, setup } = Environment.shape;
const nonEmpty = z.string().min(1);

const DIFF_LIMIT = 20_000;

const StatusInput = z
  .strictObject({
    agentId: AgentId.optional(),
    runId: RunId.optional(),
    envId: EnvironmentId.optional(),
    includeDiff: z
      .boolean()
      .optional()
      .describe(
        `With agentId: also return the branch's diff, cut at ${DIFF_LIMIT} chars.`,
      ),
  })
  .refine((i) => (i.agentId === undefined) !== (i.envId === undefined), {
    message: "pass exactly one of agentId or envId",
  })
  .refine((i) => i.runId === undefined || i.agentId !== undefined, {
    message: "runId goes with agentId",
    path: ["runId"],
  })
  .refine((i) => i.includeDiff === undefined || i.agentId !== undefined, {
    message: "includeDiff goes with agentId",
    path: ["includeDiff"],
  });

const RunList = z.object({ data: z.array(z.object({ id: RunId })) });
const RunDetail = z.looseObject({
  diff: z.string().nullish(),
  compareUrl: z.string().nullish(),
});

const clip = (diff?: string | null, compareUrl?: string | null) =>
  !diff || diff.length <= DIFF_LIMIT
    ? diff
    : `${diff.slice(0, DIFF_LIMIT)}\n[diff truncated: ${DIFF_LIMIT} of ${diff.length} chars shown; full diff at ${compareUrl ?? "the agent's branch"}]`;

function buildServer(call: Call) {
  const api = async (...args: Parameters<Call>) => {
    const outcome = await call(...args);
    return outcome.ok ? text(outcome.value) : outcome.result;
  };

  /** The id of the agent's newest run, which the list returns first. */
  const newestRun = async (
    agentId: AgentId,
  ): Promise<
    { ok: true; value: RunId } | { ok: false; result: CallToolResult }
  > => {
    const list = await call("GET", `/v1/agents/${agentId}/runs`);
    if (!list.ok) return list;
    const runs = RunList.safeParse(list.value);
    if (!runs.success) {
      const message = z.prettifyError(runs.error);
      return {
        ok: false,
        result: failure(200, "unexpected_response", message),
      };
    }
    const newest = runs.data.data[0];
    if (!newest)
      return {
        ok: false,
        result: failure(404, "no_runs", `${agentId} has no runs`),
      };
    return { ok: true, value: newest.id };
  };

  /** runId's run, else the newest one re-read singly, since the list omits the diff and pending request; the diff goes out only with includeDiff. */
  const runOf = async (
    agentId: AgentId,
    runId: RunId | undefined,
    includeDiff: boolean,
  ) => {
    const id = runId
      ? ({ ok: true, value: runId } as const)
      : await newestRun(agentId);
    if (!id.ok) return id.result;
    const run = await call("GET", `/v1/agents/${agentId}/runs/${id.value}`);
    if (!run.ok) return run.result;
    const detail = RunDetail.safeParse(run.value);
    if (!detail.success)
      return failure(200, "unexpected_response", z.prettifyError(detail.error));
    const { diff, ...rest } = detail.data;
    return text(
      includeDiff ? { ...rest, diff: clip(diff, rest.compareUrl) } : rest,
    );
  };

  const server = new McpServer({ name: "sky", version: "0.0.0" });
  server.registerTool(
    "create_env",
    {
      description: "Create an environment.",
      inputSchema: { name, repo, setup },
    },
    (input) => api("POST", "/v1/environments", input),
  );
  server.registerTool(
    "launch",
    {
      description: "Launch a new agent in a ready environment.",
      inputSchema: { envId: EnvironmentId, prompt: nonEmpty },
    },
    (input) => api("POST", "/v1/agents", input),
  );
  server.registerTool(
    "followup",
    {
      description: "Start the agent's next run, resuming its session.",
      inputSchema: { agentId: AgentId, prompt: nonEmpty },
    },
    ({ agentId, prompt }) =>
      api("POST", `/v1/agents/${agentId}/runs`, { prompt }),
  );
  server.registerTool(
    "answer",
    {
      description: "Answer the question a waiting run asked.",
      inputSchema: { agentId: AgentId, requestId: RequestId, answer: nonEmpty },
    },
    ({ agentId, ...body }) =>
      api("POST", `/v1/agents/${agentId}/answers`, body),
  );
  server.registerTool(
    "approve",
    {
      description:
        "Approve or deny the tool call a waiting run asked to make; a reason goes only with deny.",
      inputSchema: {
        agentId: AgentId,
        requestId: RequestId,
        decision: z.enum(["approve", "deny"]),
        reason: nonEmpty
          .optional()
          .describe("Why the call is denied; sent only with deny."),
      },
    },
    ({ agentId, reason, ...body }) =>
      api("POST", `/v1/agents/${agentId}/approvals`, {
        ...body,
        ...(body.decision === "deny" && reason !== undefined && { reason }),
      }),
  );
  server.registerTool(
    "stop",
    {
      description: "Stop the agent's active run.",
      inputSchema: { agentId: AgentId },
      annotations: { destructiveHint: true },
    },
    ({ agentId }) => api("POST", `/v1/agents/${agentId}/stop`),
  );
  server.registerTool(
    "status",
    {
      description:
        "With agentId: a run (runId, or the newest) with its rollup, compareUrl and any pending request; its diff only with includeDiff. With envId: the environment, e.g. to poll provisioning.",
      inputSchema: StatusInput,
      annotations: { readOnlyHint: true },
    },
    ({ agentId, runId, envId, includeDiff = false }) =>
      agentId
        ? runOf(agentId, runId, includeDiff)
        : api("GET", `/v1/environments/${envId}`),
  );
  return server;
}

/** A stateless streamable-HTTP MCP endpoint whose tools call `/v1`. */
export function createMcpHandler(
  options: McpHandlerOptions,
): (request: Request) => Promise<Response> {
  const checked = HandlerOptions.safeParse(options);
  if (!checked.success)
    throw new TypeError(`createMcpHandler: ${z.prettifyError(checked.error)}`);
  const api = apiClient(options);
  return async (request) => {
    // stateless: a GET stream would sit on a server that never emits, and there is no session to DELETE
    if (request.method !== "POST")
      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        },
        { status: 405, headers: { allow: "POST" } },
      );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await buildServer(api).connect(transport);
    return transport.handleRequest(request);
  };
}
