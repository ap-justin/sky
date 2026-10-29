import type { SpritesClient } from "@fly/sprites";
import type { Db } from "@harness/db";
import type { Context } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { agentRoutes } from "./agents.js";
import type { Config } from "./config.js";
import { environmentRoutes } from "./environments.js";
import { apiError } from "./errors.js";
import { factory } from "./factory.js";
import { internalRoutes } from "./internal.js";
import { createLauncher } from "./launch.js";
import { createProvisioner } from "./provision.js";
import { KnownSecrets } from "./redact.js";

export type AppDeps = {
  db: Db;
  config: Config;
  sprites: SpritesClient;
  log: (line: string) => void;
};

export function createApp({ db, config, sprites, log }: AppDeps) {
  // bearerAuth answers a malformed header with 400; every auth failure here is one 401
  const unauthorized = (message: string) => (c: Context) =>
    apiError(c, 401, "unauthorized", message);

  const secrets = KnownSecrets.fromConfig(config);
  const provisioner = createProvisioner({ db, secrets, sprites, log });
  const launcher = createLauncher({ db, config, secrets, sprites, log });
  const v1 = factory
    .createApp()
    .route("/environments", environmentRoutes(provisioner, sprites, log))
    .route("/agents", agentRoutes(launcher, sprites, log));

  const app = factory
    .createApp()
    .use(logger(log))
    .use(async (c, next) => {
      c.set("db", db);
      c.set("config", config);
      c.set("secrets", secrets);
      await next();
    })
    .get("/healthz", (c) => {
      try {
        db.$client.prepare("select 1").get();
      } catch {
        return apiError(c, 503, "db_unreachable", "database is unreachable");
      }
      return c.json({ status: "ok", db: "ok" } as const, 200);
    })
    // the runner's own channel, authenticated per run by its agent token rather than the API key
    .route("/internal", internalRoutes())
    .use(
      "/v1/*",
      bearerAuth({
        token: config.apiKey,
        noAuthenticationHeader: {
          message: unauthorized("missing bearer token"),
        },
        invalidAuthenticationHeader: {
          message: unauthorized("malformed Authorization header"),
        },
        invalidToken: { message: unauthorized("invalid bearer token") },
      }),
    )
    .route("/v1", v1);

  app.onError((err, c) => {
    // a thrown HTTPException (bearerAuth's 401) already carries its enveloped response
    if (err instanceof HTTPException) return err.getResponse();
    log(`${c.req.method} ${c.req.path} failed: ${err.stack ?? err}`);
    return apiError(c, 500, "internal", "internal server error");
  });
  app.notFound((c) => apiError(c, 404, "not_found", "no such route"));
  return app;
}

export type AppType = ReturnType<typeof createApp>;
