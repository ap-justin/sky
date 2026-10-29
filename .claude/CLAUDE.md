# harness

Self-hosted cloud agents for Claude Code: a Hono API on Fly drives Claude sessions inside Fly Sprites (one sprite per project, one session + git worktree per agent), fans out signed webhooks, and serves an MCP server for Grok Bot. Fly-first: reach for a Fly product before adding a vendor.

<!-- kru v0.159.0 · derived 2026-10-29 · `skills/setup/SKILL.md` to re-derive -->
## Team

Load **`skills/lead/SKILL.md`** before building, reviewing, or dispatching a seat — it carries how the
team works.

Repo is pre-scaffold; every line below cites the decision standing in for a manifest (`← decided 2026-10-29 · /brief`).

- **api** → `kru:hono-builder` — `apps/api`: routes, SSE, webhook fan-out, `@fly/sprites` calls; Hono on `@hono/node-server`, Node 24 (`@fly/sprites` requires ≥24)
- **data** → `kru:sqlite-architect` — `db/`: SQLite on the API machine's Fly volume via `better-sqlite3`, Drizzle `sqlite` dialect, migrations at boot
- **platform** → `kru:fly-platform-engineer` — `fly.toml`, `Dockerfile`, the volume, `fly secrets`, Sprites org + connectors
- **programs** → `kru:node-developer` — `packages/runner` (exec'd inside a sprite, Agent SDK), `packages/cli` (`harness apply`, `harness secret set`)
- **packages** → `kru:extension-builder` — `packages/mcp` (streamable HTTP, mounted by `apps/api` at `/mcp`), `packages/shared`
- **tooling** → `kru:toolchain-engineer` — root `package.json`, `pnpm-workspace.yaml`, `biome.json`, `tsconfig.base.json`; pnpm 10.19.0, no Turborepo
- **skills** → `drizzle`, `zod`, `vitest`, `msw`, `api-design`, `claude-api` — Drizzle, Zod 4, Vitest + MSW decided; `api-design` for the versioned `/v1` surface and outbound webhooks; `claude-api` for the runner's `@anthropic-ai/claude-agent-sdk`
- **screens** — none; API only, so no design-spec gate
- **test** → `pnpm test` (Vitest; Sprites, GitHub and Anthropic are mocked with MSW, never called live)
- **verify** → `pnpm typecheck && pnpm lint` (`tsc -b`, `biome check`)
- **mcp** → `fly` (flyctl, local scope) ← `claude mcp list`; `context7` at user scope

A slice reaching a stack no seat above covers is a question for the user, naming the seat it would
need — never a nearby seat pressed into the gap.
