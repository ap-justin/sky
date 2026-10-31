import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CONNECTOR_ENV,
  DEFAULT_GATEWAY_URL,
  GATEWAY_URL_ENV,
  gateway,
} from "./publish.js";
import { fetchMissing, git, messageOf, remoteHead } from "./store.js";

export const REPO_PULL_USAGE = "repo-pull <owner/repo> <dir>";

type Person = { name: string; email: string; date: string };
type ApiCommit = {
  tree: { sha: string };
  parents: { sha: string }[];
  author: Person;
  committer: Person;
  message: string;
  verification?: { signature?: string | null; payload?: string | null };
};

// the commit API gives each date in UTC, dropping the zone it was written in; the zone is part of
// the commit's bytes, so the sha only comes back by finding it. UTC first: most commits have it
const OFFSETS_MIN = [
  0,
  ...Array.from({ length: 105 }, (_, i) => (i - 48) * 15).filter((m) => m),
];

const zone = (minutes: number) => {
  const abs = Math.abs(minutes);
  const hhmm = `${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")}`;
  return `${minutes < 0 ? "-" : "+"}${hhmm}`;
};

const identity = (person: Person, minutes: number) =>
  `${person.name} <${person.email}> ${Math.floor(Date.parse(person.date) / 1000)} ${zone(minutes)}`;

const objectId = (body: string) => {
  const bytes = Buffer.from(body);
  return createHash("sha1")
    .update(`commit ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
};

/**
 * The commit's raw object text, which hashes to `sha`; null when no reading of what GitHub's API
 * returned does. Tries the author's and committer's zone (UTC, then every real one) and the message
 * with and without its final newline, and a signed commit with its signature put back.
 */
export function rebuildCommit(sha: string, commit: ApiCommit): string | null {
  const head = [
    `tree ${commit.tree.sha}`,
    ...commit.parents.map((p) => `parent ${p.sha}`),
  ];
  const signature = commit.verification?.signature;
  const gpgsig = signature
    ? `gpgsig ${signature.replace(/\n$/, "").split("\n").join("\n ")}`
    : null;
  const tries: [number, number][] = [
    ...OFFSETS_MIN.map((m): [number, number] => [m, m]),
    ...OFFSETS_MIN.flatMap((a) =>
      OFFSETS_MIN.filter((c) => c !== a).map((c): [number, number] => [a, c]),
    ),
  ];
  for (const [a, c] of tries) {
    const headers = [
      ...head,
      `author ${identity(commit.author, a)}`,
      `committer ${identity(commit.committer, c)}`,
    ];
    for (const extra of gpgsig ? [[gpgsig], []] : [[]]) {
      for (const tail of ["", "\n"]) {
        const text = `${[...headers, ...extra].join("\n")}\n\n${commit.message}${tail}`;
        if (objectId(text) === sha) return text;
      }
    }
  }
  return null;
}

/**
 * Materializes `repo`'s default branch in `dir` through the connector gateway, which carries REST
 * and no git transport: the branch's commit, its tree and every blob are fetched and written as git
 * objects, so the checkout holds the same commit sha as GitHub, and `origin/HEAD` names it, which
 * is what a worktree branches from and what a publish takes as its parent. The commit is shallow:
 * its ancestors stay on GitHub. `dir` must not already be a checkout.
 */
export async function pullRepo(options: {
  repo: string;
  dir: string;
  gatewayUrl: string;
  connectorId: string;
  progress?: (line: string) => void;
}): Promise<{ branch: string; sha: string }> {
  const [owner = "", name = ""] = options.repo.split("/");
  const call = gateway({
    gatewayUrl: options.gatewayUrl,
    connectorId: options.connectorId,
    owner,
    repo: name,
  });
  const progress = options.progress ?? (() => {});
  const remote = await remoteHead(call);
  const commit = await call<ApiCommit>("GET", `/git/commits/${remote.sha}`);
  const listing = await call<{
    tree: { path: string; mode: string; type: string; sha: string }[];
    truncated: boolean;
  }>("GET", `/git/trees/${commit.tree.sha}?recursive=1`);
  if (listing.truncated) {
    throw new Error(`the tree of ${options.repo} is too large to fetch`);
  }
  const raw = rebuildCommit(remote.sha, commit);
  if (raw === null) {
    throw new Error(
      `could not reproduce commit ${remote.sha} from GitHub's API; a checkout would not share its sha`,
    );
  }

  await mkdir(options.dir, { recursive: true });
  const g = git(options.dir);
  await g(["init", "-q", "-b", remote.branch]);
  const blobs = listing.tree.filter((item) => item.type === "blob");
  await fetchMissing(g, call, blobs, progress, "repo pull");
  // a submodule is a gitlink: a commit sha in the tree with nothing behind it here
  const entries = listing.tree.filter(
    (item) => item.type === "blob" || item.type === "commit",
  );
  const index = join(options.dir, ".git", "sky-pull-index");
  const env = { GIT_INDEX_FILE: index };
  try {
    await g(["update-index", "-z", "--add", "--index-info"], {
      input: entries
        .map((item) => `${item.mode} ${item.sha}\t${item.path}\0`)
        .join(""),
      env,
    });
    const tree = await g(["write-tree"], { env });
    if (tree !== commit.tree.sha) {
      throw new Error(`tree ${commit.tree.sha} arrived as ${tree}`);
    }
  } finally {
    await rm(index, { force: true });
  }
  const written = await g(["hash-object", "-t", "commit", "-w", "--stdin"], {
    input: raw,
  });
  if (written !== remote.sha) {
    throw new Error(`commit ${remote.sha} arrived as ${written}`);
  }
  if (commit.parents.length > 0) {
    await writeFile(join(options.dir, ".git", "shallow"), `${remote.sha}\n`);
  }
  const url = `https://github.com/${options.repo}.git`;
  const remoteRef = `refs/remotes/origin/${remote.branch}`;
  await g(["remote", "add", "origin", url]);
  await g(["update-ref", remoteRef, remote.sha]);
  await g(["symbolic-ref", "refs/remotes/origin/HEAD", remoteRef]);
  await g(["update-ref", `refs/heads/${remote.branch}`, remote.sha]);
  await g(["config", `branch.${remote.branch}.remote`, "origin"]);
  await g([
    "config",
    `branch.${remote.branch}.merge`,
    `refs/heads/${remote.branch}`,
  ]);
  await g(["reset", "--quiet", "--hard", remote.sha]);
  return remote;
}

/**
 * `runner.mjs repo-pull <owner/repo> <dir>`: the API's, at provisioning, for a repo a plain clone
 * can't reach. Returns the exit status: 2 for a usage or config error, 1 for a failed pull.
 */
export async function repoPullMain(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
): Promise<number> {
  const [repo, dir, ...rest] = argv;
  if (!repo || !dir || rest.length > 0 || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    io.stderr(`usage: ${REPO_PULL_USAGE}\n`);
    return 2;
  }
  const connectorId = env[CONNECTOR_ENV];
  if (!connectorId) {
    io.stderr(`repo pull: ${CONNECTOR_ENV} is not set\n`);
    return 2;
  }
  try {
    const { branch, sha } = await pullRepo({
      repo,
      dir,
      gatewayUrl: env[GATEWAY_URL_ENV] || DEFAULT_GATEWAY_URL,
      connectorId,
      progress: (line) => io.stderr(`${line}\n`),
    });
    io.stdout(`repo pull: ${repo} ${branch} at ${sha}\n`);
    return 0;
  } catch (error) {
    io.stderr(`repo pull: failed: ${messageOf(error)}\n`);
    return 1;
  }
}
