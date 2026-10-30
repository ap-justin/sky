import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpritesClient } from "@fly/sprites";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type Db, environments, migrate, openDb } from "@sky/db";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "./app.js";
import {
  type SpritesWire,
  spritesToken,
  stubSprites,
  testConfig,
} from "./testing/sprites.js";

let dir: string;
let db: Db;
let app: ReturnType<typeof createApp>;
let wire: SpritesWire;
const clients: Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sky-mcp-"));
  writeFileSync(join(dir, "runner.mjs"), "// runner bundle v1\n");
  db = openDb(":memory:");
  migrate(db);
  wire = stubSprites();
  app = createApp({
    db,
    config: testConfig({ runnerBundlePath: join(dir, "runner.mjs") }),
    sprites: new SpritesClient(spritesToken),
    log: () => {},
    nudgeDeliveries: () => {},
  });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  if (db.$client.open) db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

/** An MCP client whose transport reaches the app in-process, with no port. */
async function connect() {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://sky.test/mcp"), {
      fetch: async (url, init) => app.request(new Request(url, init)),
      requestInit: {
        headers: { authorization: `Bearer ${testConfig().apiKey}` },
      },
    }),
  );
  clients.push(client);
  return client;
}

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.parse(
    (result.content as { type: "text"; text: string }[])[0]?.text ?? "",
  );

test("/mcp without the bearer key is 401", async () => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" },
      },
    }),
  });
  expect(res.status).toBe(401);
  expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
});

test("an MCP client launches an agent then reads its run status through /v1", async () => {
  const envId = "env_mcp";
  db.insert(environments)
    .values({
      id: envId,
      name: envId,
      repo: "acme/kru",
      setup: "",
      status: "ready",
      spriteName: `sky-${envId}`,
      checkpointId: "v1",
    })
    .run();
  wire.sprites.add(`sky-${envId}`);
  const client = await connect();

  const launched = await client.callTool({
    name: "launch",
    arguments: { envId, prompt: "fix the flaky test" },
  });
  expect(launched.isError).toBeFalsy();
  const { agent, run } = textOf(launched);
  expect(agent.branch).toBe(`claude/${agent.id}`);
  await vi.waitFor(() => expect(wire.sessions).toHaveLength(1));

  const status = await client.callTool({
    name: "status",
    arguments: { agentId: agent.id },
  });
  expect(status.isError).toBeFalsy();
  expect(textOf(status)).toMatchObject({ id: run.id, agentId: agent.id });
});
