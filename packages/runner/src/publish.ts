import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";

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

/** `owner/repo` from an https or ssh GitHub remote URL. */
function parseOrigin(url: string): { owner: string; repo: string } {
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!match?.[1] || !match[2]) {
    throw new PublishError(`origin is not a GitHub repo: ${url}`);
  }
  return { owner: match[1], repo: match[2] };
}

type Identity = { name: string; email: string; date: string };

/** A git identity line's `Name <email> <unix seconds> <+hhmm>`, with the date as ISO 8601 in its own offset. */
function parseIdentity(line: string): Identity {
  const match = /^(.*) <(.*)> (\d+) ([+-])(\d\d)(\d\d)$/.exec(line);
  if (!match) throw new PublishError(`unreadable commit identity: ${line}`);
  const [, name = "", email = "", seconds, sign, hh, mm] = match;
  const offset = (sign === "-" ? -1 : 1) * (Number(hh) * 60 + Number(mm));
  const local = new Date((Number(seconds) + offset * 60) * 1000)
    .toISOString()
    .slice(0, 19);
  return { name, email, date: `${local}${sign}${hh}:${mm}` };
}

/** A commit's message, author and committer, byte for byte as git stores them. */
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
    message: split === -1 ? "" : raw.slice(split + 2),
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

/** GitHub's REST API for one repo, through the gateway, with no credential of its own. */
function gateway(options: {
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
    try {
      response = await fetch(`${root}${repoPath}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new GatewayError(
        `GitHub gateway: ${where} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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
 * Publishes the worktree's branch through the GitHub gateway, which carries no git push: each
 * commit past the base is recreated with GitHub's git data API (blobs, a tree on its parent's tree,
 * the commit with its own message and identities), then the branch ref is created or fast-forwarded
 * and a pull request into the base opened, or the open one returned. Only first-parent history is
 * replayed, so a merge commit arrives as a plain commit with the same content.
 */
export async function publish(options: {
  cwd: string;
  gatewayUrl: string;
  connectorId: string;
  /** Required unless the branch already has an open pull request. */
  title?: string;
  body?: string;
  /** Defaults to the branch `origin/HEAD` names. */
  base?: string;
}): Promise<PublishResult> {
  const { cwd } = options;
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
  const mergeBase = (
    await git(cwd, "merge-base", `origin/${base}`, "HEAD")
  ).trim();
  const commits = lines(
    await git(
      cwd,
      "rev-list",
      "--reverse",
      "--first-parent",
      `${mergeBase}..HEAD`,
    ),
  );
  if (commits.length === 0) {
    throw new PublishError(
      `no commits on ${branch} past ${base}; commit your work first`,
    );
  }

  const call = gateway({ ...options, owner, repo });
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
  // (a recreated commit's sha differs when GitHub stores its dates differently; its tree can't)
  const known = [mergeBase, ...commits];
  let start = 0;
  let parent = mergeBase;
  if (remote) {
    let at = known.indexOf(remote);
    if (at === -1) {
      const { tree } = await call<{ tree: { sha: string } }>(
        "GET",
        `/git/commits/${remote}`,
      );
      const trees = await Promise.all(known.map(treeOf));
      at = trees.lastIndexOf(tree.sha);
    }
    if (at !== -1) {
      start = at;
      parent = remote;
    }
  }

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
        remoteSha =
          blobs.get(remoteSha) ??
          (
            await call<{ sha: string }>("POST", "/git/blobs", {
              content: (
                await gitBytes(cwd, "cat-file", "blob", remoteSha)
              ).toString("base64"),
              encoding: "base64",
            })
          ).sha;
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
  } else if (remote !== parent) {
    await call("PATCH", `/git/refs/${refPath}`, {
      sha: parent,
      force: false,
    }).catch((error: unknown) => {
      if (error instanceof GatewayError && error.status === 422) {
        throw new PublishError(
          `${branch} on GitHub has commits this worktree lacks, so it can't be fast-forwarded (${error.message})`,
        );
      }
      throw error;
    });
  }

  const open = await call<{ number: number; html_url: string }[]>(
    "GET",
    `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
  );
  const existing = open[0];
  if (existing) {
    return {
      branch,
      base,
      sha: parent,
      created: false,
      pullRequest: { number: existing.number, url: existing.html_url },
    };
  }
  if (!options.title) {
    throw new PublishError("a title is needed to open the pull request");
  }
  const pull = await call<{ number: number; html_url: string }>(
    "POST",
    "/pulls",
    {
      title: options.title,
      ...(options.body !== undefined && { body: options.body }),
      head: branch,
      base,
    },
  );
  return {
    branch,
    base,
    sha: parent,
    created: true,
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
        : `sky publish: pull request #${result.pullRequest.number} was already open; ${result.branch} is now ${result.sha}\n`,
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
