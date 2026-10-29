# syntax=docker/dockerfile:1
# check=error=true

FROM node:22-bookworm-slim AS build
# toolchain for better-sqlite3's node-gyp fallback when no prebuilt binary matches the target arch
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.19.0
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
# scripts skipped: the bundle needs only esbuild, and the runtime better-sqlite3 is installed below
RUN pnpm install --frozen-lockfile --offline --ignore-scripts \
  && pnpm --filter @harness/api build
# runtime tree: the bundle, migrations at ../drizzle from it, and the bundle's one external
WORKDIR /out
RUN cp -R /repo/apps/api/dist/bundle /repo/apps/api/dist/drizzle . \
  && echo '{"private":true,"type":"module"}' > package.json \
  && npm install --omit=dev --no-package-lock --no-audit --no-fund \
    "better-sqlite3@$(node -p 'require("/repo/apps/api/node_modules/better-sqlite3/package.json").version')"

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
  DATA_DIR=/data
WORKDIR /app
COPY --from=build /out ./
EXPOSE 8080
# starts as root only to hand the volume mount (root-owned when fresh) to the node user, then execs
# node as uid node so it is PID 1 and receives SIGTERM directly
ENTRYPOINT ["/bin/sh", "-c", "mkdir -p \"$DATA_DIR\" && chown node:node \"$DATA_DIR\" && exec setpriv --reuid=node --regid=node --init-groups -- \"$@\"", "entrypoint"]
CMD ["node", "bundle/main.js"]
