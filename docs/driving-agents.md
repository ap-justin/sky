# Driving an agent from a bot

A bot (a cron job, a chat bot, a CI step) can run an agent end to end with the `sky` CLI: start it, wait until it needs something, answer or approve, follow up, read the result, archive it. Every command reads the same config as `sky apply` (`SKY_URL`, `SKY_API_KEY` or the config file) and takes `--json` to print the API's object instead of a line.

## 1. Start

```
sky agent start web --prompt=@task.md
```

`web` is an environment name or id; `--prompt=` takes the text itself, or `@path` to read it from a file. Keep the `=`: without it, a prompt starting with `-` (a markdown list, say) is read as an option. It prints the agent id and the run id:

```
agt_… run_…
```

## 2. Wait

```
sky wait agt_… --timeout=1800
```

Blocks until the agent's newest run needs input or ends, then prints what `sky inbox` prints. The exit status says which:

| exit | the newest run                                  |
| ---- | ----------------------------------------------- |
| 0    | finished                                        |
| 3    | is waiting for an answer or an approval         |
| 4    | is still starting or running (`wait` timed out) |
| 5    | failed                                          |
| 6    | was stopped                                     |

`wait` rides out a dropped connection or a 5xx by retrying, up to 30 seconds apart, so without `--timeout` it waits through an outage for as long as the outage lasts; pass `--timeout` to bound that too. Exit 1 means the API refused the call (an unknown agent, say), and 2 a bad argument, config or API key.

`sky inbox agt_…` and `sky status agt_…` exit the same way without waiting.

## 3. Read the inbox

```
sky inbox agt_…
```

Prints the pending request of the newest run, or nothing:

```
question req_…
Which database should the migration target?
```

```
approval req_… Bash
pnpm db:migrate --env production
```

With `--json` it prints the run, whose `pendingRequest` is `null` or the request.

## 4. Answer, approve or deny

```
sky answer  agt_… req_… -- "staging"
sky approve agt_… req_…
sky deny    agt_… req_… --reason="not on production"
```

Put the answer after `--`, so one starting with `-` (`- staging`, `-1`) isn't read as an option; options such as `--json` go before it. `approve` also takes `--reason=`.

These are safe to repeat. Sending exactly the same decision again succeeds like the first, so a bot that crashed after sending one can send it again. A different decision on a request already decided fails (exit 1): the first decision stands and the new one is not applied. A decision also fails when its run stopped or failed before anyone decided.

After a decision the run continues; go back to step 2.

## 5. Read the result

```
sky status agt_…
```

```
run_… finished
summary: Fixed the flaky login test and opened a pull request: https://github.com/acme/web/pull/42
compare: https://github.com/acme/web/compare/3f2a…...claude/agt_…
```

`summary` is Claude's final message; an agent whose environment has a GitHub connector publishes its branch and names the pull request there. `compare` links the branch's changes on GitHub. A failed run shows `error:` instead.

## 6. Follow up

```
sky agent follow-up agt_… --prompt="Also cover the logout path"
```

Starts the agent's next run in the same session and branch, once its last run has ended. Then go back to step 2.

## 7. Archive

```
sky agent archive agt_…
```

Stops any active run and deletes the agent's worktree, losing any uncommitted work in it; an archived agent takes no more runs.

## A whole loop

```sh
agent=$(sky agent start web --prompt=@task.md | cut -d' ' -f1)
while true; do
  sky wait "$agent" --timeout=1800 > inbox.txt; code=$?
  case $code in
    3) handle_request "$agent" inbox.txt ;;   # calls sky answer / approve / deny
    *) break ;;                               # 0 finished, 4 timed out, 5 failed, 6 stopped, 1 or 2 errors
  esac
done
sky status "$agent"
sky agent archive "$agent"
exit $code
```

The [MCP server](../README.md#mcp) offers the same steps as tools (`launch`, `wait_for_events`, `status`, `answer`, `approve`, `followup`, `archive`) for a bot that speaks MCP.
