import { z } from "zod";
import { EventType } from "./event.js";
import { WebhookId } from "./ids.js";

export const Webhook = z.object({
  id: WebhookId,
  url: z.httpUrl(),
  eventTypes: z.array(EventType).nonempty(),
});
export type Webhook = z.infer<typeof Webhook>;
