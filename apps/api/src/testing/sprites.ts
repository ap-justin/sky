import { createHash } from "node:crypto";
import { HttpResponse, http, ws } from "msw";
import { server } from "../../../../test/msw.js";
import type { Config } from "../config.js";

export const spritesToken = "sprites-test-token";
const SPRITES = "https://api.sprites.dev/v1/sprites";

export const testConfig = (overrides: Partial<Config> = {}): Config => ({
  apiKey: "k".repeat(40),
  spritesToken,
  dataDir: "/unused",
  port: 8080,
  claudeOauthToken: "sk-ant-oat01-test-oauth-token",
  publicBaseUrl: "https://harness.test",
  runnerBundlePath: "/unused/runner.mjs",
  runTimeoutMs: 30 * 60_000,
  webhookSigningKey: "webhook-signing-key-for-tests-0123456789",
  ...overrides,
});

export type ExecOutcome = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

/** A detachable session as the WebSocket exec endpoint received it. */
export type Session = {
  sprite: string;
  dir: string | null;
  argv: string[];
  env: Record<string, string>;
  tty: boolean;
  detachable: boolean;
};

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** In-memory Sprites API speaking the wire format @fly/sprites reads. */
export function stubSprites() {
  const wire = {
    sprites: new Set<string>(),
    /** Files written through the filesystem API, by absolute path. */
    files: new Map<string, Uint8Array>(),
    /**
     * One line per call, in order: `create <name>`, `exec <name> <dir> <argv…>`, `write <name> <path>`,
     * `session <name> <dir> <argv…>`, `checkpoint <name>`, `delete <name>`.
     */
    calls: [] as string[],
    sessions: [] as Session[],
    /** WebSocket exec connections the client has not closed. */
    openSockets: 0,
    // answers `sha256sum <path>` from `files`, as coreutils would
    exec: (argv: string[]): ExecOutcome => {
      if (argv[0] === "sha256sum" && argv[1]) {
        const bytes = wire.files.get(argv[1]);
        return bytes
          ? { exitCode: 0, stdout: `${sha256(bytes)}  ${argv[1]}\n` }
          : {
              exitCode: 1,
              stderr: `sha256sum: ${argv[1]}: No such file or directory\n`,
            };
      }
      return { exitCode: 0 };
    },
    createStatus: 201,
    writeStatus: 200,
    checkpointLines: undefined as object[] | undefined,
    deleteStatus: 204,
  };
  let checkpoints = 0;
  const authorized = (request: Request) =>
    request.headers.get("authorization") === `Bearer ${spritesToken}`;

  const execLink = ws.link("wss://api.sprites.dev/v1/sprites/:name/exec");

  server.use(
    http.post(SPRITES, async ({ request }) => {
      if (!authorized(request)) return new HttpResponse(null, { status: 401 });
      const { name } = (await request.json()) as { name: string };
      wire.calls.push(`create ${name}`);
      if (wire.createStatus !== 201) {
        return HttpResponse.json(
          { error: "sprite quota exceeded" },
          { status: wire.createStatus },
        );
      }
      wire.sprites.add(name);
      return HttpResponse.json(
        { id: `spr_${name}`, name, status: "cold" },
        { status: 201 },
      );
    }),
    http.post(`${SPRITES}/:name/exec`, ({ request, params }) => {
      if (!authorized(request)) return new HttpResponse(null, { status: 401 });
      const name = String(params.name);
      const url = new URL(request.url);
      const argv = url.searchParams.getAll("cmd");
      wire.calls.push(
        `exec ${name} ${url.searchParams.get("dir") ?? "-"} ${argv.join(" ")}`,
      );
      if (!wire.sprites.has(name)) {
        return HttpResponse.json({ error: "not found" }, { status: 404 });
      }
      const outcome = wire.exec(argv);
      const enc = new TextEncoder();
      // one frame per chunk: a stream-id byte, then the payload; exit is [3, code]
      const frames = [
        ...(outcome.stdout ? [[1, ...enc.encode(outcome.stdout)]] : []),
        ...(outcome.stderr ? [[2, ...enc.encode(outcome.stderr)]] : []),
        [3, outcome.exitCode],
      ];
      // the SDK splits frames on read boundaries, so each goes out on its own tick, as the
      // live server flushes them; enqueued together they coalesce into one read
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const frame = frames.shift();
          if (!frame) return controller.close();
          await new Promise((resolve) => setTimeout(resolve, 0));
          controller.enqueue(new Uint8Array(frame));
        },
      });
      return new HttpResponse(body, {
        headers: { "content-type": "application/octet-stream" },
      });
    }),
    http.put(`${SPRITES}/:name/fs/write`, async ({ request, params }) => {
      if (!authorized(request)) return new HttpResponse(null, { status: 401 });
      const name = String(params.name);
      const path = new URL(request.url).searchParams.get("path") ?? "";
      wire.calls.push(`write ${name} ${path}`);
      if (wire.writeStatus !== 200) {
        return HttpResponse.json(
          { error: "write failed" },
          { status: wire.writeStatus },
        );
      }
      wire.files.set(path, new Uint8Array(await request.arrayBuffer()));
      return HttpResponse.json({ path, size: wire.files.get(path)?.length });
    }),
    // the WebSocket upgrade's headers are out of MSW's reach, so this one can't check the bearer
    execLink.addEventListener("connection", ({ client, params }) => {
      const name = String(params.name);
      const url = client.url;
      const argv = url.searchParams.getAll("cmd");
      const env = Object.fromEntries(
        url.searchParams.getAll("env").map((pair) => {
          const at = pair.indexOf("=");
          return [pair.slice(0, at), pair.slice(at + 1)];
        }),
      );
      const dir = url.searchParams.get("dir");
      wire.calls.push(`session ${name} ${dir ?? "-"} ${argv.join(" ")}`);
      wire.sessions.push({
        sprite: name,
        dir,
        argv,
        env,
        tty: url.searchParams.get("tty") === "true",
        detachable: url.searchParams.get("detachable") === "true",
      });
      wire.openSockets += 1;
      client.addEventListener("close", () => {
        wire.openSockets -= 1;
      });
    }),
    http.post(`${SPRITES}/:name/checkpoint`, ({ request, params }) => {
      if (!authorized(request)) return new HttpResponse(null, { status: 401 });
      const name = String(params.name);
      wire.calls.push(`checkpoint ${name}`);
      checkpoints += 1;
      const time = "2026-10-29T00:00:00Z";
      const lines = wire.checkpointLines ?? [
        { type: "info", data: "Creating checkpoint...", time },
        { type: "complete", data: `Checkpoint v${checkpoints} created`, time },
      ];
      return new HttpResponse(
        `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
        { headers: { "content-type": "application/x-ndjson" } },
      );
    }),
    http.delete(`${SPRITES}/:name`, ({ request, params }) => {
      if (!authorized(request)) return new HttpResponse(null, { status: 401 });
      const name = String(params.name);
      wire.calls.push(`delete ${name}`);
      if (wire.deleteStatus !== 204) {
        return HttpResponse.json(
          { error: "upstream unavailable" },
          { status: wire.deleteStatus },
        );
      }
      if (!wire.sprites.delete(name)) {
        return HttpResponse.json({ error: "not found" }, { status: 404 });
      }
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return wire;
}

export type SpritesWire = ReturnType<typeof stubSprites>;
