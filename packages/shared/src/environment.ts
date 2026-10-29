import { z } from "zod";
import { EnvironmentId } from "./ids.js";

export const EnvironmentStatus = z.enum(["provisioning", "ready", "failed"]);
export type EnvironmentStatus = z.infer<typeof EnvironmentStatus>;

export const Environment = z.object({
  id: EnvironmentId,
  name: z.string().trim().min(1).max(100),
  /** GitHub `owner/name`; reaches a `git clone` inside the sprite, so nothing beyond the slug charset. */
  repo: z
    .string()
    .regex(
      /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/,
      "expected a GitHub repo as owner/name",
    ),
  /** Shell script run once after clone, before the checkpoint. */
  setup: z.string(),
  status: EnvironmentStatus,
  spriteName: z.string().min(1),
  /** Null until the post-setup checkpoint exists. */
  checkpointId: z.string().min(1).nullable(),
  /** Max agents running at once in this environment's sprite. */
  concurrency: z.int().positive().default(3),
  /** Tool-name patterns whose calls wait for an approval decision. */
  approvalPolicy: z.array(z.string().min(1)).default(() => []),
});
export type Environment = z.infer<typeof Environment>;
