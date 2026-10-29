import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { boot, shutdown } from "./boot.js";
import { loadConfig } from "./config.js";

const result = loadConfig(process.env);
if (!result.ok) {
  console.error(result.message);
  process.exit(1);
}
const { config } = result;

const { app, db, stopSweeping, stopDelivering } = boot(config, console.log);
// with no `createServer` option, serve() builds an HTTP/1 server
const server = serve({ fetch: app.fetch, port: config.port }, (info) =>
  console.log(`listening on :${info.port}`),
) as Server;

process.once("SIGTERM", () => {
  stopSweeping();
  stopDelivering()
    .then(() => shutdown(server, db))
    .then(
      () => process.exit(0),
      (err: unknown) => {
        console.error("shutdown failed", err);
        process.exit(1);
      },
    );
});
