import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** The body of every non-2xx response. */
export const apiError = <S extends ContentfulStatusCode>(
  c: Context,
  status: S,
  code: string,
  message: string,
) => c.json({ error: { code, message } }, status);
