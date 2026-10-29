import {
  AgentId,
  Environment,
  EnvironmentId,
  RequestId,
  RunId,
} from "@harness/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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

const StatusInput = z
  .strictObject({
    agentId: AgentId.optional(),
    runId: RunId.optional(),
    envId: EnvironmentId.optional(),
  })
  .refine((i) => (i.agentId === undefined) !== (i.envId === undefined), {
    message: "pass exactly one of agentId or envId",
  })
  .refine((i) => i.runId === undefined || i.agentId !== undefined, {
    message: "runId goes with agentId",
    path: ["runId"],
  });

const RunList = z.object({ data: z.array(z.object({ id: RunId })) });

function buildServer(call: Call) {
  const api = async (...args: Parameters<Call>) => {
    const outcome = await call(...args);
    return outcome.ok ? text(outcome.value) : outcome.result;
  };

  /** runId's run, else the newest one re-read singly, since the list omits the diff and pending request. */
  const runOf = async (agentId: AgentId, runId: RunId | undefined) => {
    if (runId) return api("GET", `/v1/agents/${agentId}/runs/${runId}`);
    const list = await call("GET", `/v1/agents/${agentId}/runs`);
    if (!list.ok) return list.result;
    const runs = RunList.safeParse(list.value);
    if (!runs.success)
      return failure(200, "unexpected_response", z.prettifyError(runs.error));
    const newest = runs.data.data[0];
    if (!newest) return failure(404, "no_runs", `${agentId} has no runs`);
    return api("GET", `/v1/agents/${agentId}/runs/${newest.id}`);
  };

  const server = new McpServer({ name: "harness", version: "0.0.0" });
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
        reason: nonEmpty.optional(),
      },
    },
    ({ agentId, ...body }) =>
      api("POST", `/v1/agents/${agentId}/approvals`, body),
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
        "With agentId: a run (runId, or the newest) with its diff and any pending request. With envId: the environment, e.g. to poll provisioning.",
      inputSchema: StatusInput,
      annotations: { readOnlyHint: true },
    },
    ({ agentId, runId, envId }) =>
      agentId ? runOf(agentId, runId) : api("GET", `/v1/environments/${envId}`),
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
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await buildServer(api).connect(transport);
    return transport.handleRequest(request);
  };
}
