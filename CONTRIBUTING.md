# Contributing

## Prerequisites

- Node 24 or newer (`@fly/sprites` requires it)
- pnpm 10.19.0 (`corepack enable` picks it up from `packageManager`)

## Install and check

```
pnpm install
pnpm typecheck && pnpm lint   # tsc -b; biome, plus a check that each custom lint rule still fires
pnpm test                     # vitest; Sprites, GitHub and Anthropic are mocked, nothing is called live
pnpm build                    # bundles the API, the runner and the CLI
```

All four green is the bar for a pull request.

## Running it locally

The tests need no keys. A running API does: it drives real Sprites and real Claude sessions, so it needs the same secrets a deploy does (listed at the top of [`fly.toml`](fly.toml)) as environment variables, plus `DATA_DIR` for the SQLite file and `PUBLIC_BASE_URL`, an address your sprites can reach. After `pnpm build`:

```
node apps/api/dist/bundle/main.js
node packages/cli/dist/bundle/sky.mjs --help
```

## Deploy

Sky runs as one Fly machine with a volume for its SQLite database. [`fly.toml`](fly.toml) names every secret and how to generate it; set your app name and region there, then `fly volumes create sky_data`, `fly secrets set …`, and `fly deploy`. Take volume snapshots: the database is a single copy.

Repo access goes through a Sprites connector, never a raw GitHub token in the sprite.

## Brand

`brand/` holds the hand-drawn masters (`sky-mark.svg`, `sky-mark-16.svg`, `sky-tile.svg`, `sky-wordmark.svg`); every other file there comes from `node brand/build.mjs`.
