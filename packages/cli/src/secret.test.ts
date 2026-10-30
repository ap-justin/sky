import { HttpResponse, http } from "msw";
import { beforeEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { apiKey, apiUrl, runCli } from "./testing.js";

const value = "s3cr3t-value-do-not-print";
const puts: { path: string; body: unknown }[] = [];

beforeEach(() => {
  puts.length = 0;
});

const putSecret = (response: Record<string, unknown>) =>
  http.put(
    `${apiUrl}/v1/environments/:id/secrets/:name`,
    async ({ request, params }) => {
      if (request.headers.get("authorization") !== `Bearer ${apiKey}`) {
        return new HttpResponse(null, { status: 401 });
      }
      puts.push({
        path: `${params.id}/${params.name}`,
        body: await request.json(),
      });
      return HttpResponse.json(response);
    },
  );
const list = http.get(`${apiUrl}/v1/environments`, () =>
  HttpResponse.json({
    data: [
      {
        id: "env_1",
        name: "web",
        repo: "acme/web",
        setup: "",
        status: "ready",
        spriteName: "s",
        checkpointId: null,
        concurrency: 3,
        approvalPolicy: [],
        autoApprove: { defaults: true, commands: [] },
        failure: null,
      },
    ],
  }),
);

test("a piped value is sent and never printed", async () => {
  server.use(putSecret({ name: "TOKEN", kind: "value" }));
  const r = await runCli(["secret", "set", "env_1", "TOKEN"], {
    stdin: { readAll: async () => `${value}\n` },
  });
  expect(r.code).toBe(0);
  expect(puts).toEqual([{ path: "env_1/TOKEN", body: { value } }]);
  expect(r.stdout).toBe("set TOKEN (value)\n");
  expect(r.stdout).not.toContain(value);
  expect(r.stderr).not.toContain(value);
});

test("an env name is resolved to its id", async () => {
  server.use(list, putSecret({ name: "TOKEN", kind: "value" }));
  const r = await runCli(["secret", "set", "web", "TOKEN"], {
    stdin: { readAll: async () => value },
  });
  expect(r.code).toBe(0);
  expect(puts[0]?.path).toBe("env_1/TOKEN");
});

test("an unknown env name exits 1", async () => {
  server.use(list);
  const r = await runCli(["secret", "set", "nope", "TOKEN"], {
    stdin: { readAll: async () => value },
  });
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/no environment named nope/);
});

test("--connector sets a connector secret without reading stdin", async () => {
  server.use(putSecret({ name: "GH", kind: "connector", connector: "github" }));
  const r = await runCli(
    ["secret", "set", "env_1", "GH", "--connector=github"],
    {
      stdin: {
        readAll: async () => {
          throw new Error("stdin read");
        },
      },
    },
  );
  expect(r.code).toBe(0);
  expect(puts).toEqual([{ path: "env_1/GH", body: { connector: "github" } }]);
  expect(r.stdout).toBe("set GH (connector)\n");
});

test("on a terminal the value comes from a hidden prompt", async () => {
  server.use(putSecret({ name: "TOKEN", kind: "value" }));
  const prompts: string[] = [];
  const r = await runCli(["secret", "set", "env_1", "TOKEN"], {
    stderrIsTTY: true,
    stdin: {
      isTTY: true,
      promptHidden: async (p) => {
        prompts.push(p);
        return value;
      },
    },
  });
  expect(r.code).toBe(0);
  expect(prompts).toEqual(["Value for TOKEN: "]);
  expect(puts[0]?.body).toEqual({ value });
  expect(r.stderr).not.toContain(value);
});

test("a terminal stdin with CI set refuses to prompt", async () => {
  const r = await runCli(["secret", "set", "env_1", "TOKEN"], {
    env: { CI: "true" },
    stderrIsTTY: true,
    stdin: { isTTY: true },
  });
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/pipe the value on stdin/);
});

test("an empty value exits 2 without a request", async () => {
  const r = await runCli(["secret", "set", "env_1", "TOKEN"], {
    stdin: { readAll: async () => "\n" },
  });
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/empty/);
});

test("the API's rejection exits 1", async () => {
  server.use(
    http.put(`${apiUrl}/v1/environments/:id/secrets/:name`, () =>
      HttpResponse.json(
        { error: { code: "invalid_name", message: "bad name" } },
        { status: 400 },
      ),
    ),
  );
  const r = await runCli(["secret", "set", "env_1", "1BAD"], {
    stdin: { readAll: async () => value },
  });
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("bad name (invalid_name)");
  expect(r.stderr).not.toContain(value);
});

test("--json prints the API object", async () => {
  server.use(putSecret({ name: "TOKEN", kind: "value" }));
  const r = await runCli(["secret", "set", "--json", "env_1", "TOKEN"], {
    stdin: { readAll: async () => value },
  });
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ name: "TOKEN", kind: "value" });
});

test("a value on argv is a usage error", async () => {
  for (const argv of [
    ["secret", "set", "env_1", "TOKEN", value],
    ["secret", "set", "env_1"],
    ["secret", "get", "env_1", "TOKEN"],
    ["secret"],
  ]) {
    const r = await runCli(argv);
    expect(r.code, argv.join(" ")).toBe(2);
    expect(r.stderr).not.toContain(value);
  }
});
