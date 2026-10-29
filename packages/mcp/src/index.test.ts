import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HttpResponse, http, type JsonBodyType } from "msw";
import { afterEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { createMcpHandler, type Fetch } from "./index.js";

const API = "https://api.test";
const KEY = "hk_test";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connect(fetch?: Fetch) {
  const handler = createMcpHandler({ baseUrl: API, apiKey: KEY, fetch });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://mcp.test/mcp"), {
      fetch: (url, init) => handler(new Request(url, init)),
    }),
  );
  clients.push(client);
  return client;
}

/** Answers one route, recording the bearer and JSON body it received. */
function route(
  method: "get" | "post",
  path: string,
  status: number,
  body: JsonBodyType,
) {
  const seen: { auth: string | null; body: unknown }[] = [];
  server.use(
    http[method](`${API}${path}`, async ({ request }) => {
      seen.push({
        auth: request.headers.get("authorization"),
        body: method === "post" ? await request.json().catch(() => null) : null,
      });
      return HttpResponse.json(body, { status });
    }),
  );
  return seen;
}

const rawText = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as { type: "text"; text: string }[])[0]?.text ?? "";
const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.parse(rawText(result));

test("create_env posts the env and returns it", async () => {
  const env = { id: "env_1", name: "web", status: "provisioning" };
  const seen = route("post", "/v1/environments", 202, env);
  const client = await connect();

  const result = await client.callTool({
    name: "create_env",
    arguments: { name: "web", repo: "acme/web", setup: "pnpm i" },
  });

  expect(result.isError).toBeFalsy();
  expect(textOf(result)).toEqual(env);
  expect(seen).toEqual([
    {
      auth: `Bearer ${KEY}`,
      body: { name: "web", repo: "acme/web", setup: "pnpm i" },
    },
  ]);
});

test("launch posts envId and prompt, returning the agent and its run", async () => {
  const launched = { agent: { id: "agt_1" }, run: { id: "run_1" } };
  const seen = route("post", "/v1/agents", 202, launched);
  const client = await connect();

  const result = await client.callTool({
    name: "launch",
    arguments: { envId: "env_1", prompt: "fix the build" },
  });

  expect(textOf(result)).toEqual(launched);
  expect(seen.map((s) => s.body)).toEqual([
    { envId: "env_1", prompt: "fix the build" },
  ]);
});

test("an API error comes back as a tool error carrying its code and message", async () => {
  route("post", "/v1/agents", 409, {
    error: {
      code: "concurrency_cap",
      message: "env is at its cap of 3",
      limit: 3,
    },
  });
  const client = await connect();

  const result = await client.callTool({
    name: "launch",
    arguments: { envId: "env_1", prompt: "go" },
  });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toEqual({
    status: 409,
    error: {
      code: "concurrency_cap",
      message: "env is at its cap of 3",
      limit: 3,
    },
  });
});

test("a non-envelope error keeps its status and body", async () => {
  server.use(
    http.post(
      `${API}/v1/agents`,
      () => new HttpResponse("bad gateway", { status: 502 }),
    ),
  );
  const client = await connect();

  const result = await client.callTool({
    name: "launch",
    arguments: { envId: "env_1", prompt: "go" },
  });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toEqual({
    status: 502,
    error: { code: "http_502", message: "bad gateway" },
  });
});

test("an injected fetch that fails comes back as api_unreachable", async () => {
  const client = await connect(() => {
    throw new TypeError("fetch failed");
  });

  const result = await client.callTool({
    name: "launch",
    arguments: { envId: "env_1", prompt: "go" },
  });

  expect(result.isError).toBe(true);
  expect(textOf(result).error).toEqual({
    code: "api_unreachable",
    message: "TypeError: fetch failed",
  });
});

test("an id outside its prefix charset is rejected before any API call", async () => {
  const client = await connect();

  const result = await client.callTool({
    name: "launch",
    arguments: { envId: "env_1/../../x", prompt: "go" },
  });

  expect(result.isError).toBe(true);
  expect(rawText(result)).toMatch(/envId/);
});

test("followup posts a prompt as the agent's next run", async () => {
  const run = { id: "run_2", status: "queued" };
  const seen = route("post", "/v1/agents/agt_1/runs", 202, run);
  const client = await connect();

  const result = await client.callTool({
    name: "followup",
    arguments: { agentId: "agt_1", prompt: "now add tests" },
  });

  expect(textOf(result)).toEqual(run);
  expect(seen.map((s) => s.body)).toEqual([{ prompt: "now add tests" }]);
});

test("answer posts the answer to the agent's open question", async () => {
  const decided = { id: "req_1", decision: { answer: "use pnpm" } };
  const seen = route("post", "/v1/agents/agt_1/answers", 200, decided);
  const client = await connect();

  const result = await client.callTool({
    name: "answer",
    arguments: { agentId: "agt_1", requestId: "req_1", answer: "use pnpm" },
  });

  expect(textOf(result)).toEqual(decided);
  expect(seen.map((s) => s.body)).toEqual([
    { requestId: "req_1", answer: "use pnpm" },
  ]);
});

test("approve posts a deny decision with its reason", async () => {
  const decided = { id: "req_2", decision: { decision: "deny" } };
  const seen = route("post", "/v1/agents/agt_1/approvals", 200, decided);
  const client = await connect();

  const result = await client.callTool({
    name: "approve",
    arguments: {
      agentId: "agt_1",
      requestId: "req_2",
      decision: "deny",
      reason: "not on main",
    },
  });

  expect(textOf(result)).toEqual(decided);
  expect(seen.map((s) => s.body)).toEqual([
    { requestId: "req_2", decision: "deny", reason: "not on main" },
  ]);
});

test("stop posts to the agent's stop route", async () => {
  const stopped = { id: "agt_1", status: "idle" };
  const seen = route("post", "/v1/agents/agt_1/stop", 200, stopped);
  const client = await connect();

  const result = await client.callTool({
    name: "stop",
    arguments: { agentId: "agt_1" },
  });

  expect(textOf(result)).toEqual(stopped);
  expect(seen).toHaveLength(1);
});

test("status with a runId returns that run", async () => {
  const run = {
    id: "run_1",
    status: "waiting",
    diff: "+x",
    pendingRequest: { id: "req_1" },
  };
  route("get", "/v1/agents/agt_1/runs/run_1", 200, run);
  const client = await connect();

  const result = await client.callTool({
    name: "status",
    arguments: { agentId: "agt_1", runId: "run_1" },
  });

  expect(textOf(result)).toEqual(run);
});

test("status without a runId fetches the newest run singly", async () => {
  route("get", "/v1/agents/agt_1/runs", 200, {
    data: [{ id: "run_9" }, { id: "run_3" }],
  });
  const run = {
    id: "run_9",
    status: "succeeded",
    diff: "+y",
    pendingRequest: null,
  };
  route("get", "/v1/agents/agt_1/runs/run_9", 200, run);
  const client = await connect();

  const result = await client.callTool({
    name: "status",
    arguments: { agentId: "agt_1" },
  });

  expect(textOf(result)).toEqual(run);
});

test("status with an envId returns the environment", async () => {
  const env = { id: "env_1", status: "ready", failure: null };
  route("get", "/v1/environments/env_1", 200, env);
  const client = await connect();

  const result = await client.callTool({
    name: "status",
    arguments: { envId: "env_1" },
  });

  expect(textOf(result)).toEqual(env);
});

test.each([
  [{ agentId: "agt_1", envId: "env_1" }, /exactly one of agentId or envId/],
  [{}, /exactly one of agentId or envId/],
  [{ envId: "env_1", runId: "run_1" }, /runId goes with agentId/],
])("status rejects %j before any API call", async (args, message) => {
  const client = await connect();

  const result = await client.callTool({ name: "status", arguments: args });

  expect(result.isError).toBe(true);
  expect(rawText(result)).toMatch(message);
});

test.each([
  [{ baseUrl: "not a url", apiKey: KEY }, /baseUrl/],
  [{ baseUrl: API, apiKey: "" }, /apiKey/],
])("createMcpHandler rejects bad options %j", (options, message) => {
  expect(() => createMcpHandler(options)).toThrow(message);
});
