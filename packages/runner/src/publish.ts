import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { fetchCommit } from "./repo.js";
import { git as repoGit } from "./store.js";

const run = promisify(execFile);

/** Where a sprite reaches GitHub's REST API through a Sprites connector; the gateway adds the credential. */
export const DEFAULT_GATEWAY_URL = "https://api.sprites.dev/v1/gateway/github";
/** The env var holding the connector's connection id: a connector secret of this name sets it. */
export const CONNECTOR_ENV = "GITHUB_CONNECTOR";
/** Overrides `DEFAULT_GATEWAY_URL`. */
export const GATEWAY_URL_ENV = "GITHUB_GATEWAY_URL";

/** GitHub, through the gateway, answered something other than success. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** The worktree can't be published as it stands. */
export class PublishError extends Error {}

export type PublishResult = {
  branch: string;
  base: string;
  /** The branch head on GitHub. */
  sha: string;
  /** False when an open pull request for the branch already existed. */
  created: boolean;
  /** True when an already-open pull request was sent a new title or body. */
  updated: boolean;
  pullRequest: { number: number; url: string };
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function gitBytes(cwd: string, ...args: string[]): Promise<Buffer> {
  const { stdout } = await run("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

const lines = (output: string) => output.split("\n").filter(Boolean);

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** A failed git command's own words, not execFile's "Command failed: …" wrapper. */
const gitSaid = (error: unknown) =>
  (error as { stderr?: string }).stderr?.trim() || messageOf(error);

/** `owner/repo` from an https or ssh GitHub remote URL. */
function parseOrigin(url: string): { owner: string; repo: string } {
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!match?.[1] || !match[2]) {
    throw new PublishError(`origin is not a GitHub repo: ${url}`);
  }
  return { owner: match[1], repo: match[2] };
}

type Identity = { name: string; email: string; date: string };

/**
 * A git identity line's `Name <email> <unix seconds> <+hhmm>`, its date in UTC: the
 * `YYYY-MM-DDTHH:MM:SSZ` form GitHub documents, though it drops the commit's own offset.
 */
function parseIdentity(line: string): Identity {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (!match) throw new PublishError(`unreadable commit identity: ${line}`);
  const [, name = "", email = "", seconds] = match;
  const date = `${new Date(Number(seconds) * 1000).toISOString().slice(0, 19)}Z`;
  return { name, email, date };
}

const CLAUDE_ATTRIBUTION = [
  /^\s*🤖\s*Generated with .*Claude Code.*$/i,
  // keyed on the address, not the name: a person named Claude keeps their credit
  /^\s*Co-Authored-By:.*<noreply@anthropic\.com>\s*$/i,
];
const isAttribution = (line: string) =>
  CLAUDE_ATTRIBUTION.some((pattern) => pattern.test(line));
const TRAILER = /^\s*[\w-]+:\s/;

/**
 * Drops the lines Claude Code appends on its own, the "Generated with Claude Code" footer and
 * `Co-Authored-By: … <noreply@anthropic.com>` trailers, with the blank lines they leave. Only the
 * trailing run of trailer, footer and blank lines is searched; the same line anywhere above it, a
 * fenced example included, is kept.
 */
export function stripClaudeAttribution(text: string): string {
  const all = text.split("\n");
  let start = all.length;
  while (start > 0) {
    const line = all[start - 1] ?? "";
    if (line.trim() && !isAttribution(line) && !TRAILER.test(line)) break;
    start--;
  }
  const block = all.slice(start);
  if (!block.some(isAttribution)) return text;
  const kept = block
    .filter((line) => !isAttribution(line))
    // a dropped paragraph between two kept ones leaves its blank lines doubled
    .filter((line, i, lines) => line.trim() || lines[i - 1]?.trim() !== "");
  const body = [...all.slice(0, start), ...kept].join("\n").trimEnd();
  return text.endsWith("\n") && body ? `${body}\n` : body;
}

/** A commit's author and committer as git stores them; its message less Claude's attribution. */
async function readCommit(cwd: string, sha: string) {
  const raw = await git(cwd, "cat-file", "commit", sha);
  const split = raw.indexOf("\n\n");
  const headers = lines(split === -1 ? raw : raw.slice(0, split));
  const header = (key: string) => {
    const line = headers.find((h) => h.startsWith(`${key} `));
    if (!line) throw new PublishError(`commit ${sha} has no ${key}`);
    return parseIdentity(line.slice(key.length + 1));
  };
  return {
    message: stripClaudeAttribution(split === -1 ? "" : raw.slice(split + 2)),
    author: header("author"),
    committer: header("committer"),
  };
}

type TreeEntry = {
  path: string;
  mode: string;
  type: "blob" | "commit";
  sha: string | null;
};

type Change = { path: string; mode: string; sha: string | null };

/** What changed from `from` to `to`: each path's new mode and blob, or a null sha where it went. */
async function changes(cwd: string, from: string, to: string) {
  const out = await git(cwd, "diff-tree", "-r", "-z", "--no-renames", from, to);
  // -z: ":<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0", repeated
  const fields = out.split("\0");
  const result: Change[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode = "", newMode = "", , newSha = "", status] = (
      fields[i] ?? ""
    )
      .slice(1)
      .split(" ");
    const path = fields[i + 1] ?? "";
    result.push(
      status === "D"
        ? { path, mode: oldMode, sha: null }
        : { path, mode: newMode, sha: newSha },
    );
  }
  return result;
}

// GitHub's secondary rate limit answers 403 or 429 with a `retry-after`; a pause this long is waited out
const MAX_RETRY_AFTER_S = 60;
const RETRIES = 3;
// a stalled gateway call fails rather than holding the caller
const REQUEST_TIMEOUT_MS = 120_000;

/** GitHub's REST API for one repo, through the gateway, with no credential of its own. */
export function gateway(options: {
  gatewayUrl: string;
  connectorId: string;
  owner: string;
  repo: string;
}) {
  const root = `${options.gatewayUrl.replace(/\/+$/, "")}/${encodeURIComponent(options.connectorId)}`;
  const repoPath = `/repos/${options.owner}/${options.repo}`;
  return async function call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const where = `${method} ${repoPath}${path}`;
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await fetch(`${root}${repoPath}${path}`, {
          method,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            ...(body !== undefined && { "content-type": "application/json" }),
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
      } catch (error) {
        // fetch's own message is just "fetch failed"; the reason is its cause
        const cause = error instanceof Error ? error.cause : undefined;
        throw new GatewayError(
          `GitHub gateway: ${where} failed: ${messageOf(error)}${cause ? ` (${messageOf(cause)})` : ""}`,
        );
      }
      const retryAfter = Number(response.headers.get("retry-after") ?? NaN);
      if (
        (response.status === 403 || response.status === 429) &&
        retryAfter >= 0 &&
        retryAfter <= MAX_RETRY_AFTER_S &&
        attempt < RETRIES
      ) {
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        continue;
      }
      break;
    }
    if (response.ok) return (await response.json()) as T;
    const text = await response.text();
    let detail = text.trim() || response.statusText;
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === "string") detail = parsed.message;
    } catch {}
    throw new GatewayError(
      `GitHub gateway: ${where} returned ${response.status}: ${detail}`,
      response.status,
    );
  };
}

/**
 * Every base head a publish fetched into this clone, one ref per commit. A base fetched over REST
 * is usually shallow, so a branch rebased onto it reaches no older base, `origin/<base>` included;
 * these refs are what it is published from after that. Keyed by commit, not branch, they still
 * find the base for a branch renamed or cut from a rebased one, and one rebased onto it by hand.
 * `origin/<base>` stays where it is: every agent's worktree in the clone reads it, and moving it
 * to a shallow commit would cut every other branch off from its own base.
 */
const FETCHED_BASES = "refs/sky/bases/";

const resolves = (cwd: string, ref: string) =>
  git(cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`).then(
    (sha) => sha.trim(),
    () => "",
  );

/**
 * The branch a rebase stopped in this worktree is rewriting, "" when git didn't record one, or
 * undefined when no rebase is in progress. `rebase-merge` is the merge backend's state directory,
 * `rebase-apply` the apply backend's, and `git am`'s too, marked by an `applying` file.
 */
async function rebaseInProgress(cwd: string): Promise<string | undefined> {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const path = (
      await git(cwd, "rev-parse", "--path-format=absolute", "--git-path", dir)
    ).trim();
    if (!existsSync(path) || existsSync(join(path, "applying"))) continue;
    const head = await readFile(join(path, "head-name"), "utf8").catch(
      () => "",
    );
    return head.trim().replace(/^refs\/heads\//, "");
  }
  return undefined;
}

/**
 * Rebases this branch's commits from `mergeBase` onto GitHub's current head of the base, which a
 * sandbox's clone, made once at provisioning, falls behind, so what is published sits on the base
 * as it is now, not as the clone saw it. The head commit is materialized from the REST API when it
 * isn't here, and recorded under `FETCHED_BASES` before the rebase starts, so a rebase that stops
 * or is killed, or is redone by hand, leaves it known. A failed rebase is aborted and fails the
 * publish before anything is sent to GitHub: as a conflict where git stopped on one, else with
 * git's own message.
 */
async function refreshBase(
  cwd: string,
  call: ReturnType<typeof gateway>,
  options: { base: string; branch: string; mergeBase: string },
): Promise<void> {
  const { base, branch, mergeBase } = options;
  const { object } = await call<{ object: { sha: string } }>(
    "GET",
    `/git/ref/heads/${base.split("/").map(encodeURIComponent).join("/")}`,
  ).catch((error: unknown) => {
    if (error instanceof GatewayError && error.status === 404) {
      throw new PublishError(
        `${base} doesn't exist on GitHub, so there is nothing to open a pull request into (${error.message})`,
      );
    }
    throw error;
  });
  if (object.sha === mergeBase) return;
  await fetchCommit(repoGit(cwd), call, object.sha);
  await git(cwd, "update-ref", `${FETCHED_BASES}${object.sha}`, object.sha);
  // the rebase commits as whoever git is configured as; a sandbox may have no identity of its own
  const identity = (await git(cwd, "config", "user.email").catch(() => ""))
    ? []
    : ["-c", "user.name=sky-agent", "-c", "user.email=agent@sky.local"];
  try {
    await git(
      cwd,
      ...identity,
      // the repo's hooks and the user's signing are no part of moving commits, and either could fail it
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "rebase",
      "--quiet",
      "--onto",
      object.sha,
      mergeBase,
    );
  } catch (error) {
    // one line per stage of each unmerged path: "<mode> <sha> <stage>\t<path>"
    const conflicted = [
      ...new Set(
        lines(await git(cwd, "ls-files", "--unmerged").catch(() => "")).map(
          (line) => line.slice(line.indexOf("\t") + 1),
        ),
      ),
    ];
    // a rebase refused before it began, as on a held index.lock, leaves nothing to abort
    const stuck =
      (await rebaseInProgress(cwd)) === undefined
        ? ""
        : await git(cwd, "rebase", "--abort").then(
            () => "",
            (abort: unknown) =>
              `; \`git rebase --abort\` failed too, so the worktree is left mid-rebase with HEAD detached, and commits made now land on no branch; run it again once git allows, before anything else (${gitSaid(abort)})`,
          );
    if (conflicted.length) {
      throw new PublishError(
        `${base} moved on GitHub to ${object.sha}, and this branch's commits don't rebase onto it cleanly; rebase them by hand with \`git rebase --onto ${object.sha} ${mergeBase}\`, resolve the conflicts, and publish again (conflict in ${conflicted.join(", ")})${stuck}`,
      );
    }
    throw new PublishError(
      `rebasing ${branch} onto ${base} at ${object.sha} failed: ${gitSaid(error)}${stuck}`,
    );
  }
}

/**
 * Publishes the worktree's branch through the GitHub gateway, which carries no git push: each
 * commit past the base is recreated with GitHub's git data API (blobs, a tree on its parent's tree,
 * the commit with its own message and identities), then the branch ref is created or fast-forwarded
 * and a pull request into the base opened, or the open one given the new title and body. Claude
 * Code's attribution is stripped from each commit message and the pull request's body, never its
 * title. The base is first refreshed to GitHub's current head, with the branch's commits rebased
 * onto it when it moved (`refreshBase`). That rebase flattens a merge: the merge commit is dropped
 * and the commits it brought in are replayed one by one. Where the base hasn't moved, only
 * first-parent history is replayed, so a merge commit arrives as a plain commit with the same
 * content, and a merge from the base shows the base's changes in the pull request's diff as the
 * branch's own. A branch on GitHub whose head this branch
 * held before a rebase or amend here is force-updated to the rewritten history; one holding a
 * commit this branch never had is only ever fast-forwarded.
 */
export async function publish(options: {
  cwd: string;
  gatewayUrl: string;
  connectorId: string;
  /** Required unless the branch already has an open pull request; given for one, it replaces the title. */
  title?: string;
  /** Given for an open pull request, it replaces the body. */
  body?: string;
  /** Defaults to the branch `origin/HEAD` names. */
  base?: string;
}): Promise<PublishResult> {
  const { cwd } = options;
  const rebasing = await rebaseInProgress(cwd);
  if (rebasing !== undefined) {
    // a rebase detaches HEAD until it finishes, so this is checked before the branch is read
    throw new PublishError(
      `a rebase${rebasing ? ` of ${rebasing}` : ""} is in progress here, left by an earlier run that stopped mid-way; run \`git rebase --abort\` to return the branch to where it was, then publish again`,
    );
  }
  const branch = (
    await git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "")
  ).trim();
  if (!branch) throw new PublishError("HEAD is detached; check out a branch");
  if ((await git(cwd, "status", "--porcelain")).trim()) {
    throw new PublishError(
      "the worktree has uncommitted changes; commit them first, publish sends commits only",
    );
  }
  const base =
    options.base ??
    (await git(cwd, "rev-parse", "--abbrev-ref", "origin/HEAD"))
      .trim()
      .replace(/^origin\//, "");
  const { owner, repo } = parseOrigin(
    (await git(cwd, "remote", "get-url", "origin")).trim(),
  );
  const pending = async () => {
    // the newest of the clone's base and every base a publish fetched; a clone pulled through the
    // connector holds only the default branch, so a branch cut from it is rebased from there onto
    // GitHub's head of any other base
    const clonedRef = (await resolves(cwd, `refs/remotes/origin/${base}`))
      ? `origin/${base}`
      : "origin/HEAD";
    const [cloned, fetched] = await Promise.all([
      resolves(cwd, clonedRef),
      git(cwd, "for-each-ref", "--format=%(objectname)", FETCHED_BASES),
    ]);
    const bases = [cloned, ...lines(fetched)].filter(Boolean);
    const found = lines(
      await git(cwd, "merge-base", "--all", "HEAD", ...bases).catch(() => ""),
    );
    if (found.length > 1) {
      // without --all git outputs an unspecified one of these; from any one, the rebase and the
      // commit list would take the others' history as this branch's own
      const [newest] = lines(await git(cwd, "rev-list", "--no-walk", ...found));
      throw new PublishError(
        `${branch} has more than one merge base with ${base} here, none an ancestor of another (${found.join(", ")}), as after a merge of unrelated histories, so which commits are its own is ambiguous; move them onto a new branch with \`git switch -c ${branch}-on-${base} ${newest}\` and \`git cherry-pick --no-merges ${found.map((sha) => `^${sha}`).join(" ")} ${branch}\`, then publish that`,
      );
    }
    const [mergeBase] = found;
    if (!mergeBase) {
      // a rebase onto the base would replay the branch's root commit, adding every file, and
      // conflict wherever the base has one too
      throw new PublishError(
        `${branch} shares no commit here with ${base} or any base a publish fetched, so there is no base to publish it onto; move its commits onto a new branch from ${clonedRef} with \`git switch -c ${branch}-on-${base} ${clonedRef}\` and \`git cherry-pick ${clonedRef}..${branch}\`, then publish that`,
      );
    }
    const commits = lines(
      await git(
        cwd,
        "rev-list",
        "--reverse",
        "--first-parent",
        `${mergeBase}..HEAD`,
      ),
    );
    return { mergeBase, commits };
  };
  const local = await pending();
  if (local.commits.length === 0) {
    throw new PublishError(
      `no commits on ${branch} past ${base}; commit your work first`,
    );
  }

  const call = gateway({ ...options, owner, repo });
  // the ref lookup below reads a 404 as a new branch, which a repo the connector can't see also returns
  await call("GET", "").catch((error: unknown) => {
    if (error instanceof GatewayError && error.status === 404) {
      throw new PublishError(
        `the connector in ${CONNECTOR_ENV} can't see ${owner}/${repo}; check its connection id and the repos it grants (${error.message})`,
      );
    }
    throw error;
  });
  // before the base is refreshed, so a missing title leaves the branch and the clone as they were
  const [existing] = await call<{ number: number; html_url: string }[]>(
    "GET",
    `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
  );
  if (!existing && !options.title) {
    throw new PublishError("a title is needed to open the pull request");
  }
  await refreshBase(cwd, call, {
    base,
    branch,
    mergeBase: local.mergeBase,
  });
  const { mergeBase, commits } = await pending();
  // the rebase drops a commit whose change the base already holds
  if (commits.length === 0) {
    throw new PublishError(
      `the changes on ${branch} are already on ${base} on GitHub, so there is nothing left to publish`,
    );
  }
  const refPath = `heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
  const treeOf = async (sha: string) =>
    (await git(cwd, "rev-parse", `${sha}^{tree}`)).trim();

  const remote = await call<{ object: { sha: string } }>(
    "GET",
    `/git/ref/${refPath}`,
  ).then(
    (ref) => ref.object.sha,
    (error: unknown) => {
      if (error instanceof GatewayError && error.status === 404) return null;
      throw error;
    },
  );

  // replay from the last local commit GitHub already holds: the same sha, or else the same tree
  // (a recreated commit's sha differs once its date's offset is dropped; its tree can't)
  const known = [mergeBase, ...commits];
  let start = 0;
  let parent = mergeBase;
  // GitHub's head is one this branch held before it was rebased or amended here, so the rewritten
  // history replaces it; a head this branch never held is someone else's, and is never overwritten
  let rewritten = false;
  if (remote) {
    let at = known.indexOf(remote);
    if (at === -1) {
      const { tree } = await call<{ tree: { sha: string } }>(
        "GET",
        `/git/commits/${remote}`,
      );
      const trees = await Promise.all(known.map(treeOf));
      at = trees.lastIndexOf(tree.sha);
      if (at === -1) {
        const held = await git(
          cwd,
          "log",
          "--walk-reflogs",
          "--format=%H %T",
          `refs/heads/${branch}`,
        ).catch(() => "");
        rewritten = lines(held).some((line) => {
          const [sha, heldTree] = line.split(" ");
          return sha === remote || heldTree === tree.sha;
        });
      }
    }
    if (at !== -1) {
      start = at;
      parent = remote;
    }
  }

  // a blob's sha is the hash of its content, on GitHub as here, so one an earlier or failed publish
  // uploaded is found rather than sent again; a lookup costs less of the rate limit than a create
  const uploadBlob = async (sha: string) => {
    const found = await call<{ sha: string }>("GET", `/git/blobs/${sha}`).then(
      (blob) => blob.sha,
      (error: unknown) => {
        if (error instanceof GatewayError && error.status === 404) return null;
        throw error;
      },
    );
    if (found) return found;
    const content = await gitBytes(cwd, "cat-file", "blob", sha);
    return (
      await call<{ sha: string }>("POST", "/git/blobs", {
        content: content.toString("base64"),
        encoding: "base64",
      })
    ).sha;
  };

  let from = known[start] ?? mergeBase;
  let tree = await treeOf(from);
  const blobs = new Map<string, string>();
  for (const sha of known.slice(start + 1)) {
    const entries: TreeEntry[] = [];
    for (const change of await changes(cwd, from, sha)) {
      // a submodule is a commit sha in the tree, with no blob behind it
      const type = change.mode === "160000" ? "commit" : "blob";
      let remoteSha = change.sha;
      if (remoteSha !== null && type === "blob") {
        remoteSha = blobs.get(remoteSha) ?? (await uploadBlob(remoteSha));
        blobs.set(change.sha as string, remoteSha);
      }
      entries.push({
        path: change.path,
        mode: change.mode,
        type,
        sha: remoteSha,
      });
    }
    // an empty commit keeps its parent's tree; GitHub refuses a tree request with no entries
    if (entries.length > 0) {
      tree = (
        await call<{ sha: string }>("POST", "/git/trees", {
          base_tree: tree,
          tree: entries,
        })
      ).sha;
    }
    const local = await readCommit(cwd, sha);
    parent = (
      await call<{ sha: string }>("POST", "/git/commits", {
        message: local.message,
        tree,
        parents: [parent],
        author: local.author,
        committer: local.committer,
      })
    ).sha;
    from = sha;
  }

  if (remote === null) {
    await call("POST", "/git/refs", {
      ref: `refs/heads/${branch}`,
      sha: parent,
    });
  } else if (rewritten) {
    // GitHub's ref update takes no expected old value: it is read again just before the forced
    // update, so a write since the lookup above isn't overwritten
    const now = await call<{ object: { sha: string } }>(
      "GET",
      `/git/ref/${refPath}`,
    );
    if (now.object.sha !== remote) {
      throw new PublishError(
        `${branch} moved on GitHub to ${now.object.sha} while this publish ran; nothing was overwritten, publish again`,
      );
    }
    await call("PATCH", `/git/refs/${refPath}`, { sha: parent, force: true });
  } else if (remote !== parent) {
    await call("PATCH", `/git/refs/${refPath}`, {
      sha: parent,
      force: false,
    }).catch((error: unknown) => {
      if (error instanceof GatewayError && error.status === 422) {
        throw new PublishError(
          `${branch} on GitHub isn't an ancestor of this branch and holds a commit this branch never had, as when someone pushed there; it can't be fast-forwarded and isn't overwritten (${error.message})`,
        );
      }
      throw error;
    });
  }

  if (existing) {
    // the title and body are given again on a re-publish so they follow the review fixes
    const update = {
      ...(options.title && { title: options.title }),
      ...(options.body !== undefined && {
        body: stripClaudeAttribution(options.body),
      }),
    };
    const updated = Object.keys(update).length > 0;
    if (updated) await call("PATCH", `/pulls/${existing.number}`, update);
    return {
      branch,
      base,
      sha: parent,
      created: false,
      updated,
      pullRequest: { number: existing.number, url: existing.html_url },
    };
  }
  const pull = await call<{ number: number; html_url: string }>(
    "POST",
    "/pulls",
    {
      title: options.title as string,
      ...(options.body !== undefined && {
        body: stripClaudeAttribution(options.body),
      }),
      head: branch,
      base,
    },
  );
  return {
    branch,
    base,
    sha: parent,
    created: true,
    updated: false,
    pullRequest: { number: pull.number, url: pull.html_url },
  };
}

export const PUBLISH_USAGE =
  "publish --title <title> [--body <text>] [--base <branch>]";

/**
 * `runner.mjs publish …`, run by the agent from its worktree: prints the pull request's URL on
 * stdout and returns the exit status, 2 for a usage or config error.
 */
export async function publishMain(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: { cwd: string; stdout: (s: string) => void; stderr: (s: string) => void },
): Promise<number> {
  let values: { title?: string; body?: string; base?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        title: { type: "string" },
        body: { type: "string" },
        base: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    io.stderr(
      `sky publish: ${(error as Error).message}\nusage: ${PUBLISH_USAGE}\n`,
    );
    return 2;
  }
  if (values.help) {
    io.stdout(`usage: ${PUBLISH_USAGE}\n`);
    return 0;
  }
  const connectorId = env[CONNECTOR_ENV];
  if (!connectorId) {
    io.stderr(
      `sky publish: ${CONNECTOR_ENV} is not set; set a connector secret: sky secret set <env> ${CONNECTOR_ENV} --connector=<connection id>\n`,
    );
    return 2;
  }
  try {
    const result = await publish({
      cwd: io.cwd,
      gatewayUrl: env[GATEWAY_URL_ENV] || DEFAULT_GATEWAY_URL,
      connectorId,
      ...values,
    });
    io.stderr(
      result.created
        ? `sky publish: opened pull request #${result.pullRequest.number}\n`
        : `sky publish: pull request #${result.pullRequest.number} was already open${result.updated ? " and updated" : ""}; ${result.branch} is now ${result.sha}\n`,
    );
    io.stdout(`${result.pullRequest.url}\n`);
    return 0;
  } catch (error) {
    io.stderr(
      `sky publish: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
