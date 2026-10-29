import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { apiError } from "./errors.js";
import { factory } from "./factory.js";

// validators read the body only under a JSON content type, so anything else would validate as {}
export const jsonBody = factory.createMiddleware(async (c, next) => {
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/(?:[\w.-]+\+)?json\b/i.test(type)) {
    return apiError(c, 415, "unsupported_media_type", "send application/json");
  }
  try {
    await c.req.json();
  } catch {
    return apiError(c, 400, "invalid_json", "request body is not valid JSON");
  }
  await next();
});

export const body = <T extends z.ZodType>(schema: T) =>
  zValidator("json", schema, (result, c) => {
    if (!result.success) {
      return apiError(c, 400, "invalid_body", z.prettifyError(result.error));
    }
  });
