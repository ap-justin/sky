import { readFileSync } from "node:fs";
import { SpritesClient } from "@fly/sprites";
import { type Db, migrate, openDb } from "@harness/db";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "./app.js";
import {
  type SpritesWire,
  spritesToken,
  stubSprites,
  testConfig,
} from "./testing/sprites.js";

const apiKey = "k".repeat(40);

let db: Db;
let app: ReturnType<typeof createApp>;
let wire: SpritesWire;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
  wire = stubSprites();
  app = createApp({
    db,
    config: testConfig(),
    sprites: new SpritesClient(spritesToken),
    log: () => {},
  });
});
afterEach(() => {
  if (db.$client.open) db.$client.close();
});

const auth = { Authorization: `Bearer ${apiKey}` };
const json = { ...auth, "Content-Type": "application/json" };

const post = (body: unknown) =>
  app.request("/v1/environments", {
    method: "POST",
    headers: json,
    body: JSON.stringify(body),
  });

const get = async (id: string) => {
  const res = await app.request(`/v1/environments/${id}`, { headers: auth });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
};

/** Polls the env until its background provisioning ends. */
const settled = (id: string) =>
  vi.waitFor(async () => {
    const { body } = await get(id);
    expect(body.status).not.toBe("provisioning");
    return body;
  });

const kru = { name: "kru", repo: "acme/kru", setup: "pnpm install" };

// the runner bundle externalizes the Agent SDK, so the sprite installs the exact version the runner builds against
const runnerSdk = JSON.parse(
  readFileSync(
    new URL("../../../packages/runner/package.json", import.meta.url),
    "utf8",
  ),
).dependencies["@anthropic-ai/claude-agent-sdk"];
const installRunnerSdk = `[ -w /opt/harness ] || sudo install -d -o "$(id -u)" -g "$(id -g)" /opt/harness; npm install --prefix /opt/harness --no-audit --no-fund @anthropic-ai/claude-agent-sdk@${runnerSdk}`;

test("POST returns 202 provisioning, then the sprite is created, cloned, set up and checkpointed", async () => {
  const res = await post(kru);
  expect(res.status).toBe(202);
  const created = (await res.json()) as { id: string };
  expect(created).toEqual({
    id: expect.stringMatching(/^env_[0-9A-Za-z]+$/),
    ...kru,
    status: "provisioning",
    spriteName: `harness-${created.id}`,
    checkpointId: null,
    concurrency: 3,
    approvalPolicy: [],
    failure: null,
    createdAt: expect.stringMatching(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
    ),
  });
  expect(res.headers.get("location")).toBe(`/v1/environments/${created.id}`);

  expect(await settled(created.id)).toMatchObject({
    status: "ready",
    checkpointId: "v1",
    failure: null,
  });
  const sprite = `harness-${created.id}`;
  expect(wire.calls).toEqual([
    `create ${sprite}`,
    `exec ${sprite} - rm -rf /workspace/repo /workspace/worktrees`,
    `exec ${sprite} - git clone https://github.com/acme/kru.git /workspace/repo`,
    `exec ${sprite} - sh -c ${installRunnerSdk}`,
    `exec ${sprite} /workspace/repo bash -c pnpm install`,
    `checkpoint ${sprite}`,
  ]);
});

const ghToken = `ghp_${"a1B2".repeat(9)}`;

test.each([
  {
    step: "create",
    arrange: () => {
      wire.createStatus = 500;
    },
    stderr: expect.stringContaining("sprite quota exceeded"),
  },
  {
    step: "clone",
    arrange: () => {
      wire.exec = (argv) =>
        argv[0] === "git"
          ? {
              exitCode: 128,
              stderr: `fatal: could not read from https://${ghToken}@github.com\n`,
            }
          : { exitCode: 0 };
    },
    stderr: "fatal: could not read from https://[redacted]@github.com\n",
  },
  {
    step: "setup",
    arrange: () => {
      wire.exec = (argv) =>
        argv[0] === "bash"
          ? {
              exitCode: 1,
              stdout: "installing\n",
              stderr: "ERR_PNPM_NO_LOCKFILE\n",
            }
          : { exitCode: 0 };
    },
    stderr: "ERR_PNPM_NO_LOCKFILE\n",
  },
  {
    step: "checkpoint",
    arrange: () => {
      wire.checkpointLines = [
        { type: "error", error: "Checkpoint failed: disk full", time: "t" },
      ];
    },
    stderr: "Checkpoint failed: disk full",
  },
])(
  "a failed $step step ends failed, naming the step with a redacted stderr tail",
  async ({ step, arrange, stderr }) => {
    arrange();
    const { id } = (await (await post(kru)).json()) as { id: string };
    expect(await settled(id)).toMatchObject({
      status: "failed",
      checkpointId: null,
      failure: { step, stderr },
    });
  },
);

test("a runner SDK install that fails ends failed at the setup step", async () => {
  wire.exec = (argv) =>
    argv[0] === "sh"
      ? { exitCode: 1, stderr: "npm ERR! network\n" }
      : { exitCode: 0 };
  const { id } = (await (await post(kru)).json()) as { id: string };
  expect(await settled(id)).toMatchObject({
    status: "failed",
    failure: { step: "setup", stderr: "npm ERR! network\n" },
  });
  expect(wire.calls.some((c) => c.includes("bash -c"))).toBe(false);
});

test("a setup that fails with no stderr names its exit code", async () => {
  wire.exec = (argv) =>
    argv[0] === "bash" ? { exitCode: 2 } : { exitCode: 0 };
  const { id } = (await (await post(kru)).json()) as { id: string };
  expect(await settled(id)).toMatchObject({
    failure: { step: "setup", stderr: "exited with code 2" },
  });
});

test("a second POST with the same name gets 409 and never creates a second sprite", async () => {
  const first = (await (await post(kru)).json()) as { id: string };
  await settled(first.id);
  const res = await post({ ...kru, repo: "acme/other" });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: { code: "name_taken", message: expect.any(String) },
  });
  expect(wire.calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
});

test("POST without a bearer gets 401 and touches no sprite", async () => {
  const res = await app.request("/v1/environments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(kru),
  });
  expect(res.status).toBe(401);
  expect(wire.calls).toEqual([]);
});

test.each([
  [
    "a repo that isn't owner/name",
    { ...kru, repo: "acme/kru; rm -rf /" },
    400,
    "invalid_body",
  ],
  ["a missing setup", { name: "kru", repo: "acme/kru" }, 400, "invalid_body"],
  ["an unknown field", { ...kru, status: "ready" }, 400, "invalid_body"],
  [
    "a non-positive concurrency",
    { ...kru, concurrency: 0 },
    400,
    "invalid_body",
  ],
])(
  "POST with %s gets %i %s and creates nothing",
  async (_, payload, status, code) => {
    const res = await post(payload);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({
      error: { code, message: expect.any(String) },
    });
    expect(wire.calls).toEqual([]);
  },
);

test.each([
  ["no content type", auth, JSON.stringify(kru), 415, "unsupported_media_type"],
  [
    "a form content type",
    { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
    "name=kru",
    415,
    "unsupported_media_type",
  ],
  ["malformed JSON", json, "{", 400, "invalid_json"],
])(
  "POST with %s gets an enveloped %i",
  async (_, headers, body, status, code) => {
    const res = await app.request("/v1/environments", {
      method: "POST",
      headers,
      body,
    });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({
      error: { code, message: expect.any(String) },
    });
  },
);

test("GET lists environments oldest first; an unknown or malformed id is 404", async () => {
  const b = (await (await post({ ...kru, name: "b" })).json()) as {
    id: string;
  };
  const a = (await (await post({ ...kru, name: "a" })).json()) as {
    id: string;
  };
  await settled(a.id);
  await settled(b.id);
  // both can land in the same millisecond; pin the order the list must follow
  db.$client
    .prepare("update environments set created_at = ? where id = ?")
    .run("2026-01-02T00:00:00.000Z", a.id);
  db.$client
    .prepare("update environments set created_at = ? where id = ?")
    .run("2026-01-01T00:00:00.000Z", b.id);
  const res = await app.request("/v1/environments", { headers: auth });
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as { data: { id: string }[] };
  expect(data.map((e) => e.id)).toEqual([b.id, a.id]);
  for (const id of ["env_doesNotExist", "not-an-id"]) {
    const missing = await get(id);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      error: { code: "not_found", message: expect.any(String) },
    });
  }
});

/** Inserts an agent on the env with one run in `status`. */
function seedRun(envId: string, status: "running" | "finished") {
  const agentId = `agt_${envId.slice(4)}`;
  db.$client
    .prepare(
      "insert into agents (id, env_id, branch, status) values (?, ?, ?, 'idle')",
    )
    .run(agentId, envId, `claude/${agentId}`);
  db.$client
    .prepare("insert into runs (id, agent_id, status) values (?, ?, ?)")
    .run(`run_${envId.slice(4)}`, agentId, status);
}

const patch = (id: string, body: unknown) =>
  app.request(`/v1/environments/${id}`, {
    method: "PATCH",
    headers: json,
    body: JSON.stringify(body),
  });

const ready = async (env = kru) => {
  const { id } = (await (await post(env)).json()) as { id: string };
  await settled(id);
  wire.calls.length = 0;
  return id;
};

test("PATCH of name, concurrency or policy updates in place with 200 and no sprite calls", async () => {
  const id = await ready({ ...kru, concurrency: 5 } as typeof kru);
  const res = await patch(id, { name: "kru2", approvalPolicy: ["Bash"] });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    name: "kru2",
    concurrency: 5,
    approvalPolicy: ["Bash"],
    status: "ready",
    checkpointId: "v1",
  });
  expect(wire.calls).toEqual([]);
});

test("PATCH that changes setup reruns setup and replaces checkpointId", async () => {
  const id = await ready();
  const res = await patch(id, { setup: "pnpm install --frozen-lockfile" });
  expect(res.status).toBe(202);
  expect(await res.json()).toMatchObject({
    status: "provisioning",
    checkpointId: null,
  });
  expect(await settled(id)).toMatchObject({
    status: "ready",
    checkpointId: "v2",
  });
  const sprite = `harness-${id}`;
  expect(wire.calls).toEqual([
    `exec ${sprite} - rm -rf /workspace/repo /workspace/worktrees`,
    `exec ${sprite} - git clone https://github.com/acme/kru.git /workspace/repo`,
    `exec ${sprite} - sh -c ${installRunnerSdk}`,
    `exec ${sprite} /workspace/repo bash -c pnpm install --frozen-lockfile`,
    `checkpoint ${sprite}`,
  ]);
});

test("PATCH that changes repo re-clones from the new remote", async () => {
  const id = await ready();
  expect((await patch(id, { repo: "acme/kru-next" })).status).toBe(202);
  expect(await settled(id)).toMatchObject({
    status: "ready",
    repo: "acme/kru-next",
  });
  expect(wire.calls).toContain(
    `exec harness-${id} - git clone https://github.com/acme/kru-next.git /workspace/repo`,
  );
});

test("PATCH that resends the current repo and setup is an in-place 200", async () => {
  const id = await ready();
  expect((await patch(id, { repo: kru.repo, setup: kru.setup })).status).toBe(
    200,
  );
  expect(wire.calls).toEqual([]);
});

test("PATCH after a failed create recreates the sprite before cloning", async () => {
  wire.createStatus = 500;
  const { id } = (await (await post(kru)).json()) as { id: string };
  await settled(id);
  wire.createStatus = 201;
  expect((await patch(id, { setup: "true" })).status).toBe(202);
  expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
  expect(wire.calls.filter((c) => c.startsWith("create"))).toHaveLength(2);
});

test("PATCH is 409 while a run is active, and a finished run doesn't block it", async () => {
  const id = await ready();
  seedRun(id, "running");
  const res = await patch(id, { concurrency: 4 });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: { code: "run_active", message: expect.any(String) },
  });

  const other = await ready({ ...kru, name: "other" });
  seedRun(other, "finished");
  expect((await patch(other, { concurrency: 4 })).status).toBe(200);
});

test("PATCH of repo or setup is 409 while provisioning; a rename is not", async () => {
  const { id } = (await (await post(kru)).json()) as { id: string };
  const res = await patch(id, { setup: "make" });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: { code: "provisioning", message: expect.any(String) },
  });
  expect((await patch(id, { name: "renamed" })).status).toBe(200);
  expect(await settled(id)).toMatchObject({ name: "renamed", status: "ready" });
});

test("PATCH to a taken name is 409; an empty PATCH changes nothing", async () => {
  await ready({ ...kru, name: "taken" });
  const id = await ready();
  expect((await patch(id, { name: "taken" })).status).toBe(409);
  const res = await patch(id, {});
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    name: "kru",
    concurrency: 3,
    approvalPolicy: [],
  });
});

const del = (id: string) =>
  app.request(`/v1/environments/${id}`, { method: "DELETE", headers: auth });

test("DELETE destroys the sprite, then the row and its agents' history", async () => {
  const id = await ready();
  seedRun(id, "finished");
  const res = await del(id);
  expect(res.status).toBe(204);
  expect(wire.calls).toEqual([`delete harness-${id}`]);
  expect(wire.sprites.size).toBe(0);
  expect((await get(id)).status).toBe(404);
  expect(db.$client.prepare("select count(*) as n from agents").get()).toEqual({
    n: 0,
  });
});

test("DELETE is 409 while a run is active and while provisioning, and keeps the sprite", async () => {
  const id = await ready();
  seedRun(id, "running");
  expect((await del(id)).status).toBe(409);
  const { id: fresh } = (await (
    await post({ ...kru, name: "fresh" })
  ).json()) as { id: string };
  const res = await del(fresh);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: { code: "provisioning", message: expect.any(String) },
  });
  await settled(fresh);
  expect(wire.calls.filter((c) => c.startsWith("delete"))).toEqual([]);
});

test("DELETE keeps the row and answers 502 when the sprite can't be destroyed", async () => {
  const id = await ready();
  wire.deleteStatus = 503;
  const res = await del(id);
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({
    error: { code: "sprite_destroy_failed", message: expect.any(String) },
  });
  expect((await get(id)).status).toBe(200);
});

test("DELETE of an env whose sprite never got created still removes the row", async () => {
  wire.createStatus = 500;
  const { id } = (await (await post(kru)).json()) as { id: string };
  await settled(id);
  expect((await del(id)).status).toBe(204);
  expect((await get(id)).status).toBe(404);
});

test("a failure is persisted, so it survives the app that recorded it", async () => {
  wire.exec = (argv) =>
    argv[0] === "bash" ? { exitCode: 1, stderr: "boom\n" } : { exitCode: 0 };
  const { id } = (await (await post(kru)).json()) as { id: string };
  await settled(id);
  expect(
    db.$client
      .prepare(
        "select failure_step, failure_stderr from environments where id = ?",
      )
      .get(id),
  ).toEqual({ failure_step: "setup", failure_stderr: "boom\n" });
});

test("a retry clears the previous failure while it provisions", async () => {
  wire.exec = (argv) =>
    argv[0] === "bash" ? { exitCode: 1, stderr: "boom\n" } : { exitCode: 0 };
  const { id } = (await (await post(kru)).json()) as { id: string };
  await settled(id);
  wire.exec = () => ({ exitCode: 0 });
  const res = await patch(id, { setup: "true" });
  expect(await res.json()).toMatchObject({
    status: "provisioning",
    failure: null,
  });
  expect(await settled(id)).toMatchObject({ status: "ready", failure: null });
});

// stands in for a writer that commits the same name between the check and the write
const raceOnName = (raced: string) =>
  db.$client.exec(`
    create temp trigger race before insert on environments when new.name = '${raced}'
    begin
      insert into environments (id, name, repo, setup, status, sprite_name)
      values ('env_racer', '${raced}', 'acme/kru', '', 'ready', 'harness-env_racer');
    end;
    create temp trigger race_rename before update of name on environments when new.name = '${raced}'
    begin
      insert into environments (id, name, repo, setup, status, sprite_name)
      values ('env_racer', '${raced}', 'acme/kru', '', 'ready', 'harness-env_racer');
    end;`);

test("a name another writer took between check and insert is still 409 name_taken", async () => {
  raceOnName("kru");
  const res = await post(kru);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: { code: "name_taken", message: expect.any(String) },
  });
  expect(wire.calls).toEqual([]);
});

test("a rename another writer raced to is still 409 name_taken", async () => {
  const id = await ready();
  raceOnName("taken");
  const res = await patch(id, { name: "taken" });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: { code: "name_taken", message: expect.any(String) },
  });
});
