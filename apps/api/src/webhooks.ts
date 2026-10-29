import { webhooks } from "@harness/db";
import { EventType, Webhook, WebhookId } from "@harness/shared";
import { zValidator } from "@hono/zod-validator";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { apiError } from "./errors.js";
import { factory } from "./factory.js";
import { mintId } from "./ids.js";
import { body, jsonBody } from "./validation.js";
import { isAllowedWebhookUrl } from "./webhook-url.js";

// any http(s) URL here, so an internal host is refused as url_not_allowed before the shared schema's domain-only rule
const WebhookInput = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
  // the shared schema's nonempty() infers a plain array; the column wants the non-empty tuple
  eventTypes: z.tuple([EventType], EventType),
});

const present = (row: typeof webhooks.$inferSelect) => ({
  ...({
    id: row.id,
    url: row.url,
    eventTypes: row.eventTypes,
  } satisfies Webhook),
  createdAt: row.createdAt,
});

const notFound = "no such webhook";

const webhookParam = zValidator(
  "param",
  z.object({ id: WebhookId }),
  (result, c) => {
    if (!result.success) return apiError(c, 404, "not_found", notFound);
  },
);

export function webhookRoutes() {
  return factory
    .createApp()
    .get("/", (c) => {
      const rows = c.var.db
        .select()
        .from(webhooks)
        .orderBy(asc(webhooks.createdAt), asc(webhooks.id))
        .all();
      return c.json({ data: rows.map(present) }, 200);
    })
    .post("/", jsonBody, body(WebhookInput), (c) => {
      const input = c.req.valid("json");
      if (!isAllowedWebhookUrl(input.url)) {
        return apiError(
          c,
          400,
          "url_not_allowed",
          "url must not name localhost or a loopback, private, link-local or unique-local address",
        );
      }
      if (!Webhook.shape.url.safeParse(input.url).success) {
        return apiError(
          c,
          400,
          "invalid_body",
          "url must be an http(s) URL whose host is a domain name",
        );
      }
      const row = c.var.db
        .insert(webhooks)
        .values({ ...input, id: mintId("whk") })
        .returning()
        .get();
      c.header("Location", `/v1/webhooks/${row.id}`);
      return c.json(present(row), 201);
    })
    .get("/:id", webhookParam, (c) => {
      const row = c.var.db
        .select()
        .from(webhooks)
        .where(eq(webhooks.id, c.req.valid("param").id))
        .get();
      if (!row) return apiError(c, 404, "not_found", notFound);
      return c.json(present(row), 200);
    })
    .delete("/:id", webhookParam, (c) => {
      const deleted = c.var.db
        .delete(webhooks)
        .where(eq(webhooks.id, c.req.valid("param").id))
        .returning({ id: webhooks.id })
        .get();
      if (!deleted) return apiError(c, 404, "not_found", notFound);
      return c.body(null, 204);
    });
}
