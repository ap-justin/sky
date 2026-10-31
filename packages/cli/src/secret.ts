import { EnvironmentId } from "@sky/shared";
import type { Api } from "./api.js";
import type { Io } from "./cli.js";
import { type Output, UsageError } from "./output.js";

/** The value never comes from argv, where `ps` and shell history would keep it. */
async function readValue(name: string, io: Io): Promise<string> {
  let raw: string;
  if (!io.stdin.isTTY) {
    raw = await io.stdin.readAll();
  } else if (io.stderrIsTTY && !io.env.CI) {
    raw = await io.stdin.promptHidden(`Value for ${name}: `);
  } else {
    throw new UsageError("no terminal to prompt on; pipe the value on stdin");
  }
  // `echo value |` and a heredoc both end in one newline that isn't part of the value
  const value = raw.replace(/\r?\n$/, "");
  if (value === "") throw new UsageError(`the value for ${name} is empty`);
  return value;
}

/** An id is used as given; anything else is looked up as a name. */
export async function resolveEnvId(api: Api, ref: string, out: Output) {
  if (EnvironmentId.safeParse(ref).success) return ref;
  const { envs } = await api.listEnvironments();
  const env = envs.find((e) => e.name === ref);
  if (env === undefined) {
    out.fail("not_found", `no environment named ${ref}`);
    return undefined;
  }
  return env.id;
}

/** `--json` prints the parsed list, not the API's raw object, so a field beyond name and kind never passes through. */
export async function secretList(
  envRef: string,
  api: Api,
  out: Output,
): Promise<number> {
  const envId = await resolveEnvId(api, envRef, out);
  if (envId === undefined) return 1;
  const secrets = await api.listSecrets(envId);
  if (secrets.length === 0 && !out.json) {
    out.progress("no secrets");
  } else {
    out.result(
      { data: secrets },
      secrets.map((s) => `${s.name} ${s.kind}`).join("\n"),
    );
  }
  return 0;
}

export async function secretDelete(
  envRef: string,
  name: string,
  api: Api,
  out: Output,
): Promise<number> {
  const envId = await resolveEnvId(api, envRef, out);
  if (envId === undefined) return 1;
  await api.deleteSecret(envId, name);
  // the API answers 204, so --json gets an object of its own rather than nothing
  out.result({ name, deleted: true }, `deleted ${name}`);
  return 0;
}

export async function secretSet(
  envRef: string,
  name: string,
  connector: string | undefined,
  api: Api,
  io: Io,
  out: Output,
): Promise<number> {
  const body =
    connector === undefined
      ? { value: await readValue(name, io) }
      : { connector };
  const envId = await resolveEnvId(api, envRef, out);
  if (envId === undefined) return 1;
  const result = await api.putSecret(envId, name, body);
  out.result(
    result,
    `set ${name} (${"value" in body ? "value" : "connector"})`,
  );
  return 0;
}
