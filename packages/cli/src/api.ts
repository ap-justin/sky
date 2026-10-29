import { Environment } from "@harness/shared";
import { z } from "zod";
import type { Config } from "./config.js";

/** An env as the API returns it; loose so `--json` passes through fields this CLI doesn't read. */
export const ApiEnvironment = Environment.extend({
  failure: z.object({ step: z.string(), stderr: z.string() }).nullable(),
}).loose();
export type ApiEnvironment = z.infer<typeof ApiEnvironment>;

const ErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

/** A non-2xx response; `code` and `message` come from the API's error envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const requestTimeoutMs = 30_000;

export type Api = ReturnType<typeof createApi>;

export function createApi(config: Config) {
  async function request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const url = `${config.url}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (err) {
      throw new ApiError(
        0,
        "unreachable",
        `cannot reach ${config.url}: ${describe(err)}`,
      );
    }
    // read on every path, the error one included, so the connection is released
    const text = await res.text();
    let json: unknown;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const parsed = ErrorBody.safeParse(json);
      throw parsed.success
        ? new ApiError(
            res.status,
            parsed.data.error.code,
            parsed.data.error.message,
          )
        : new ApiError(
            res.status,
            `http_${res.status}`,
            `${method} ${path} returned ${res.status}`,
          );
    }
    return { status: res.status, json };
  }

  const env = (status: number, json: unknown) => {
    const parsed = ApiEnvironment.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(
        status,
        "bad_response",
        "the API returned an environment this CLI can't read",
      );
    }
    return { status, raw: json, env: parsed.data };
  };

  return {
    async listEnvironments(): Promise<ApiEnvironment[]> {
      const { status, json } = await request("GET", "/v1/environments");
      const data = (json as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) {
        throw new ApiError(
          status,
          "bad_response",
          "the API returned an environment list this CLI can't read",
        );
      }
      return data.map((item) => env(status, item).env);
    },
    async getEnvironment(id: string) {
      const { status, json } = await request(
        "GET",
        `/v1/environments/${encodeURIComponent(id)}`,
      );
      return env(status, json);
    },
    async createEnvironment(body: unknown) {
      const { status, json } = await request("POST", "/v1/environments", body);
      return env(status, json);
    },
    async patchEnvironment(id: string, body: unknown) {
      const { status, json } = await request(
        "PATCH",
        `/v1/environments/${encodeURIComponent(id)}`,
        body,
      );
      return env(status, json);
    },
    async putSecret(envId: string, name: string, body: unknown) {
      const { json } = await request(
        "PUT",
        `/v1/environments/${encodeURIComponent(envId)}/secrets/${encodeURIComponent(name)}`,
        body,
      );
      return json;
    },
  };
}

function describe(err: unknown): string {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return `no response in ${requestTimeoutMs / 1000}s`;
  }
  // fetch's own message is always "fetch failed"; the reason is in cause
  const cause = (err as { cause?: { code?: unknown; message?: unknown } })
    .cause;
  if (typeof cause?.code === "string") return cause.code;
  if (typeof cause?.message === "string") return cause.message;
  return err instanceof Error ? err.message : String(err);
}
