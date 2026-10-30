import { z } from "zod";
import { EventType } from "./event.js";
import { WebhookId } from "./ids.js";

export const Webhook = z.object({
  id: WebhookId,
  /** https only: payloads carry tool input and output */
  url: z.url({ protocol: /^https$/, hostname: z.regexes.domain }),
  eventTypes: z.array(EventType).nonempty(),
});
export type Webhook = z.infer<typeof Webhook>;
