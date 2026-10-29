import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type Api, type ApiEnvironment, ApiError } from "./api.js";
import type { Io } from "./cli.js";
import { type Output, UsageError } from "./output.js";
import { type EnvSpec, parseSpec, specHash } from "./spec.js";

const pollIntervalMs = 3_000;
const provisionTimeoutMs = 30 * 60 * 1000;
const progressEveryPolls = 10;

const lockName = "harness-lock.json";
const Lock = z.object({ envId: z.string().min(1) });

type Fetched = { raw: unknown; env: ApiEnvironment };

/** Reads and validates the spec; every way it's unusable is a usage error, before any request. */
function loadSpec(file: string): EnvSpec {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new UsageError(`cannot read ${file}${code ? ` (${code})` : ""}`);
  }
  const result = parseSpec(source, file);
  if (!result.ok) throw new UsageError(result.errors.join("\n"));
  return result.spec;
}

export async function apply(
  file: string,
  api: Api,
  io: Io,
  out: Output,
): Promise<number> {
  const spec = loadSpec(file);
  const lockFile = join(dirname(file), lockName);

  let current = await findEnv(api, spec.name, readLockedId(lockFile, out));
  let changed = true;
  if (current === undefined) {
    current = await api.createEnvironment(spec);
  } else {
    const patch = changedFields(spec, current.env);
    if (Object.keys(patch).length === 0) {
      changed = false;
    } else {
      current = await api.patchEnvironment(current.env.id, patch);
    }
  }

  // an unchanged spec, or a PATCH of fields that don't reprovision, leaves a failed env failed
  if (current.env.status === "failed") {
    const step = current.env.failure?.step ?? "unknown";
    out.progress(`retrying ${spec.name} (last failed at ${step})`);
    current = await api.retryEnvironment(current.env.id);
    changed = true;
  }

  if (current.env.status === "provisioning") {
    const done = await waitForProvisioned(api, current, io, out);
    if (done === undefined) {
      return out.fail(
        "provision_timeout",
        `${spec.name} (${current.env.id}) still provisioning after ${provisionTimeoutMs / 60_000}m; re-run apply to keep waiting`,
      );
    }
    current = done;
  }

  const { env } = current;
  if (env.status === "failed") {
    const step = env.failure?.step ?? "unknown";
    const tail = env.failure?.stderr.trimEnd() ?? "";
    return out.fail(
      "provisioning_failed",
      `provisioning ${env.name} (${env.id}) failed at step ${step}`,
      tail === "" ? undefined : tail,
    );
  }

  writeLock(lockFile, {
    envId: env.id,
    spriteName: env.spriteName,
    checkpointId: env.checkpointId,
    specHash: specHash(spec),
  });
  out.result(
    current.raw,
    `${changed ? "ready" : "up to date"} ${env.name} ${env.id}`,
  );
  return 0;
}

function readLockedId(lockFile: string, out: Output): string | undefined {
  let text: string;
  try {
    text = readFileSync(lockFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    const parsed = Lock.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data.envId;
  } catch {}
  out.warn(`ignoring ${lockFile}: no envId in it`);
  return undefined;
}

/** By the lock's id first, so a renamed env is still found; by name when there's no lock or its env is gone. */
async function findEnv(
  api: Api,
  name: string,
  lockedId: string | undefined,
): Promise<Fetched | undefined> {
  if (lockedId !== undefined) {
    try {
      return await api.getEnvironment(lockedId);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
  }
  const envs = await api.listEnvironments();
  const env = envs.find((e) => e.name === name);
  return env === undefined ? undefined : { raw: env, env };
}

function changedFields(spec: EnvSpec, env: ApiEnvironment): Partial<EnvSpec> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(spec)) {
    if (JSON.stringify(value) !== JSON.stringify(env[key as keyof EnvSpec])) {
      patch[key] = value;
    }
  }
  return patch;
}

async function waitForProvisioned(
  api: Api,
  start: Fetched,
  io: Io,
  out: Output,
): Promise<Fetched | undefined> {
  const { id, name } = start.env;
  const startedAt = io.now();
  out.progress(`provisioning ${name} (${id})…`);
  let current = start;
  for (let polls = 1; current.env.status === "provisioning"; polls++) {
    if (io.now() - startedAt >= provisionTimeoutMs) return undefined;
    await io.sleep(pollIntervalMs);
    current = await api.getEnvironment(id);
    if (
      polls % progressEveryPolls === 0 &&
      current.env.status === "provisioning"
    ) {
      out.progress(`still provisioning (${elapsed(io.now() - startedAt)})`);
    }
  }
  return current;
}

const elapsed = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60
    ? `${s}s`
    : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

function writeLock(path: string, lock: Record<string, unknown>) {
  // rename over the old lock so an interrupted write never leaves half a file
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`);
  renameSync(tmp, path);
}
