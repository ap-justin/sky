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

All four commands must pass before a pull request is ready to merge.

## Running it locally

The tests need no keys. A running API does: it drives real Sprites and real Claude sessions, so it needs the same secrets a deploy does (listed at the top of [`fly.toml`](fly.toml)) as environment variables, plus `DATA_DIR` for the SQLite file and `PUBLIC_BASE_URL`, an address your sprites can reach. After `pnpm build`:

```
node apps/api/dist/bundle/main.js
node packages/cli/dist/bundle/sky.mjs --help
```

## Deploy

Sky runs as one Fly machine with a volume for its SQLite database. [`fly.toml`](fly.toml) names every secret and how to generate it; set your app name and region there, then `fly volumes create sky_data`, `fly secrets set …`, and `fly deploy`. Take volume snapshots: the database is a single copy.

Repo access goes through a Sprites connector, never a raw GitHub token in the sprite. An agent publishes with `node /opt/sky/runner.mjs publish` ([`packages/runner/src/publish.ts`](packages/runner/src/publish.ts)), which recreates its commits through GitHub's REST API at the Sprites gateway, since the gateway carries no git push. It reads the connection id from `GITHUB_CONNECTOR`, and the gateway from `GITHUB_GATEWAY_URL` (default `https://api.sprites.dev/v1/gateway/github`).

### Kru store

Kru keeps its inbox, refusal log and plan files in a store, `ap-justin/kru-store`, checked out at the root `kru-store.sh home` answers (`~/.kru`). The gateway speaks REST only, so `git clone` and `git push` can't reach that repo from a sprite; [`packages/runner/src/store.ts`](packages/runner/src/store.ts) syncs it through the same API `publish` uses, keeping a local git repo in the root for merging.

- **Provisioning** runs `runner.mjs store-sync pull` when the env has a `GITHUB_CONNECTOR` connector (a value secret by that name doesn't count), then the store's own `setup.sh`. The pull sources the env's secrets as a run does, so an env's `GITHUB_GATEWAY_URL` and `KRU_HOME` apply to it. Files already in the root are committed and merged with the remote's (the line files by Kru's `kru-lines` driver; on any other conflict the local copy wins and the remote's stays in history), never discarded. A failure is logged and doesn't fail provisioning. Repeating it changes nothing.
- **Every run** pulls before the session and pushes after it, under an exclusive `flock` on `.sky-store.lock` in the root so agents on one sprite take turns. A push that finds the remote moved pulls (rebase) and retries up to four times. A failed sync is logged to the runner's stderr and never fails the run.
- **The session** gets `KRU_STORE_REPO=ap-justin/kru-store` when the env has that connector (nothing the env stores can override it), and always `KRU_NO_STORE_SYNC=1`, which turns Kru's own sync hook off: it would clone from github.com and race the runner's sync on the same checkout, and it is what copies Claude's per-repo agent memory into the store. Setting `KRU_NO_STORE_SYNC` on the env turns the runner's sync off too, and provisioning's pull and `setup.sh`.

## Brand

`brand/` holds the hand-drawn masters (`sky-mark.svg`, `sky-mark-16.svg`, `sky-tile.svg`, `sky-wordmark.svg`); every other file there comes from `node brand/build.mjs`.
