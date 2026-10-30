<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/sky-header-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="brand/sky-header-light.svg">
  <img alt="sky" src="brand/sky-header-light.svg">
</picture>

Your Claude Code crew, in the cloud.

Sky runs Claude Code agents on your own servers while you're away. Point it at a GitHub repo, hand an agent a prompt, and it works in its own session and branch, asks you when it needs an answer or an approval, and tells you when it's done. You drive it from a REST API, a CLI, an MCP server (so a chat bot can dispatch work), and signed webhooks.

Sky is not affiliated with or endorsed by Anthropic.

## Where to use it

Sky is self-hosted: there is no shared instance. Deploy your own with [CONTRIBUTING.md](CONTRIBUTING.md#deploy); every example below uses `https://<your-app>.fly.dev`.

## Auth

Every call carries the API key you set at deploy time:

```
Authorization: Bearer <SKY_API_KEY>
```

A missing or wrong key returns `401`.

## CLI

```
sky apply env.yaml
```

Creates or updates the environment `env.yaml` describes, waits until it's provisioned, and writes `sky-lock.json` beside it:

```yaml
name: web
repo: owner/name # GitHub repo, cloned once per environment
setup: pnpm install # shell script run once after the clone
concurrency: 3 # agents running at once (default 3)
approvalPolicy: [Bash] # tool names whose calls wait for your approval
```

```
sky secret set web NPM_TOKEN < token.txt
```

Stores a secret on an environment; on a terminal it prompts without echo. `sky --help` lists the options, the config file location, and exit codes.

## Pull requests

An agent's sandbox holds no GitHub token, so `git push` and `gh` don't work there. Agents publish through a Sprites connector to GitHub instead:

1. In the Sprites org whose token Sky runs with (`SPRITES_TOKEN`), connect GitHub and give the connector a policy with `name_prefix: sky-`, so every Sky sandbox can use it.
2. Hand its connection id to an environment:

   ```
   sky secret set web GITHUB_CONNECTOR --connector=<connection id>
   ```

Agents in that environment then get `GITHUB_CONNECTOR` and are told to publish with Sky's own command, which sends the branch's commits to GitHub and opens a pull request into the default branch, or updates the one already open. The connector must belong to the same Sprites org as `SPRITES_TOKEN`; another org's connector doesn't recognize Sky's sandboxes.

## REST API

All routes live under `/v1`. Ids are prefixed: `env_…`, `agent_…`, `run_…`.

**Launch an agent** in a ready environment:

```
POST /v1/agents
{ "envId": "env_abc", "prompt": "Fix the flaky login test" }
```

`202 Accepted`, with `Location: /v1/agents/<agentId>/runs/<runId>` and a body of `{ "agent": …, "run": … }`.

| route                                                                   | what it does                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------ |
| `POST /v1/environments` · `GET`, `PATCH`, `DELETE /v1/environments/:id` | environments; create returns `202` while provisioning  |
| `PUT`, `GET`, `DELETE /v1/environments/:id/secrets[/:name]`             | environment secrets                                    |
| `POST /v1/agents/:id/runs`                                              | follow-up run, resuming the agent's session            |
| `GET /v1/agents/:id/runs/:runId` · `…/stream`                           | a run's result, or its events as SSE                   |
| `POST /v1/agents/:id/answers` · `…/approvals`                           | answer a waiting question; approve or deny a tool call |
| `POST /v1/agents/:id/stop` · `…/archive`                                | stop the current run; archive the agent                |
| `POST /v1/webhooks`                                                     | subscribe an https URL to events                       |

Errors come back as `{ "error": { "code": …, "message": … } }`. The ones you'll meet:

| code              | means                                                                        |
| ----------------- | ---------------------------------------------------------------------------- |
| `concurrency_cap` | the environment already runs its max agents; wait for one to end or stop one |
| `run_active`      | a run is in progress; wait for it or stop it                                 |
| `env_not_ready`   | the environment isn't ready to launch agents yet                             |
| `provisioning`    | the environment is still provisioning; wait for it to finish                 |
| `agents_exist`    | repo or setup can't change while unarchived agents exist                     |

## MCP

`POST /mcp` (streamable HTTP, same bearer key) exposes `create_env`, `launch`, `followup`, `status`, `answer`, `approve`, `stop` and `wait_for_events`, so a chat bot can dispatch, follow and answer agents.

`wait_for_events` waits up to 30 seconds and returns as soon as something happens, with a `cursor` to pass back as `after` on the next call. Call it in a loop to follow every agent live without a public URL. On your first call, use `status` to find agents already waiting.

## Events

What an agent does arrives as events, each with `agentId` and `runId`:

| event                                                                  | when                                                                  |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `run.started`, `run.finished`, `run.failed`, `run.stopped`             | the run's lifecycle                                                   |
| `run.waiting`                                                          | the agent needs an `answer` or an approval                            |
| `run.resumed`                                                          | a question was answered or a tool call approved or denied             |
| `claude.Message`                                                       | Claude, or a subagent (with `parentToolUseId`), wrote a message       |
| `claude.PreToolUse`, `claude.PostToolUse`, `claude.PostToolUseFailure` | a tool call starts, finishes or fails, with its input and output      |
| `claude.SubagentStart`, `claude.SubagentStop`                          | a subagent starts or finishes                                         |
| `claude.TaskCreated`, `claude.TaskCompleted`                           | a todo item is added or finished                                      |
| `claude.Notification`, `claude.PreCompact`, `claude.FileChanged`       | Claude Code's notifications, context compaction, watched-file changes |

The `claude.*` names are Claude Code's own hook names. Each text field is redacted (registered secrets and tokens) and then cut to 4,096 characters. `claude.*` events are kept for 7 days; `run.*` events are kept.

Three ways to receive them:

- **MCP:** `wait_for_events`, above.
- **Stream:** `GET /v1/stream`, one SSE connection across every agent. Filter with `?types=claude.PostToolUse,run.waiting` and `?agentId=`. After a drop, reconnect with `Last-Event-ID` to receive what you missed. A `: ping` arrives every 15 seconds. When the server restarts, the stream ends with an `event: server.shutdown` frame whose `id` is your resume point and whose `retry: 2000` asks you to reconnect in 2 seconds; `EventSource` does this on its own. `GET /v1/events?after=&wait=` is the same feed as a long poll.
- **Webhooks:** `POST /v1/webhooks` with an `https` URL and the `eventTypes` you want. Each delivery carries `Sky-Event-Type`, `Sky-Event-Id`, and

```
Sky-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">
```

keyed with your `WEBHOOK_SIGNING_KEY`. A failed delivery is retried with backoff, up to 30 attempts.

## License

[MIT](LICENSE)
