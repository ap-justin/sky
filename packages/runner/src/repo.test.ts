import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { publish } from "./publish.js";
import { pullRepo, rebuildCommit, repoPullMain } from "./repo.js";

const GATEWAY = "https://gateway.test/v1/gateway/github";
const CONNECTOR = "conn_123";
const REPO = `${GATEWAY}/${CONNECTOR}/repos/acme/private`;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let root: string;
let remote: string;
let headSha: string;

const commitAs = (cwd: string, message: string, date: string) => {
  git(cwd, "add", "--all");
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Ada L",
      "-c",
      "user.email=ada@example.com",
      "commit",
      "-qm",
      message,
    ],
    {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    },
  );
  return git(cwd, "rev-parse", "HEAD");
};

/** A private repo's history on a bare "GitHub": zones that aren't UTC, a script, a symlink, a subdir. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-repo-"));
  remote = join(root, "remote.git");
  const seed = join(root, "seed");
  execFileSync("git", ["init", "-q", "-b", "trunk", seed]);
  writeFileSync(join(seed, "README.md"), "private\n");
  commitAs(seed, "first", "2026-10-01T09:00:00+05:30");
  mkdirSync(join(seed, "src/deep"), { recursive: true });
  writeFileSync(join(seed, "src/deep/a b.ts"), "export {};\n");
  writeFileSync(join(seed, "run.sh"), "#!/bin/sh\n");
  chmodSync(join(seed, "run.sh"), 0o755);
  symlinkSync("README.md", join(seed, "link"));
  headSha = commitAs(
    seed,
    "second\n\nwith a body",
    "2026-10-02T23:15:00-08:00",
  );
  execFileSync("git", ["clone", "-q", "--bare", seed, remote]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const bare = (...args: string[]) => git(remote, ...args);

/** The fields GitHub's commit API gives: dates in UTC, the message less its final newline. */
const apiCommit = (sha: string) => {
  const person = (who: "author" | "committer") => {
    const [name = "", email = "", at = "0"] = bare(
      "show",
      "-s",
      `--format=%${who === "author" ? "a" : "c"}n%x00%${who === "author" ? "a" : "c"}e%x00%${who === "author" ? "a" : "c"}d`,
      "--date=unix",
      sha,
    ).split("\0");
    return {
      name,
      email,
      date: new Date(Number(at) * 1000).toISOString().replace(".000Z", "Z"),
    };
  };
  return {
    sha,
    tree: { sha: bare("rev-parse", `${sha}^{tree}`) },
    parents: bare("rev-list", "--parents", "-n1", sha)
      .split(" ")
      .slice(1)
      .map((p) => ({ sha: p })),
    author: person("author"),
    committer: person("committer"),
    message: bare("show", "-s", "--format=%B", sha).replace(/\n+$/, ""),
    verification: { verified: false, signature: null, payload: null },
  };
};

/** GitHub's REST API for the private repo, reachable only through the connector's gateway. */
function fakeGitHub() {
  const seen = {
    urls: [] as string[],
    commits: [] as { parents: string[]; tree: string; message: string }[],
    refs: [] as { ref: string; sha: string }[],
  };
  server.use(
    http.all(`${REPO}/*`, ({ request }) => {
      seen.urls.push(`${request.method} ${new URL(request.url).pathname}`);
      return undefined;
    }),
    http.get(REPO, () => HttpResponse.json({ default_branch: "trunk" })),
    http.get(`${REPO}/git/ref/heads/trunk`, () =>
      HttpResponse.json({ object: { sha: bare("rev-parse", "trunk") } }),
    ),
    http.get(`${REPO}/git/commits/:sha`, ({ params }) =>
      HttpResponse.json(apiCommit(String(params.sha))),
    ),
    http.get(`${REPO}/git/trees/:sha`, ({ params }) =>
      HttpResponse.json({
        truncated: false,
        tree: bare("ls-tree", "-r", "-z", String(params.sha))
          .split("\0")
          .filter(Boolean)
          .map((line) => {
            const [meta = "", path = ""] = line.split("\t");
            const [mode, type, sha] = meta.split(" ");
            return { mode, type, sha, path };
          }),
      }),
    ),
    http.get(`${REPO}/git/blobs/:sha`, ({ params }) => {
      // a blob GitHub lacks is a 404, which is how publish learns to upload it
      let content: Buffer;
      try {
        content = execFileSync(
          "git",
          ["cat-file", "blob", String(params.sha)],
          {
            cwd: remote,
            stdio: "pipe",
          },
        );
      } catch {
        return HttpResponse.json({ message: "Not Found" }, { status: 404 });
      }
      return HttpResponse.json({
        encoding: "base64",
        content: content.toString("base64"),
      });
    }),
    http.get(`${REPO}/git/ref/*`, () =>
      HttpResponse.json({ message: "Not Found" }, { status: 404 }),
    ),
    // publish: its blobs are new to GitHub, its branch doesn't exist, no pull request is open
    http.post(`${REPO}/git/blobs`, () =>
      HttpResponse.json({ sha: "b".repeat(40) }, { status: 201 }),
    ),
    http.post(`${REPO}/git/trees`, () =>
      HttpResponse.json({ sha: "c".repeat(40) }, { status: 201 }),
    ),
    http.post(`${REPO}/git/commits`, async ({ request }) => {
      seen.commits.push((await request.json()) as never);
      return HttpResponse.json({ sha: "d".repeat(40) }, { status: 201 });
    }),
    http.post(`${REPO}/git/refs`, async ({ request }) => {
      seen.refs.push((await request.json()) as never);
      return HttpResponse.json({}, { status: 201 });
    }),
    http.get(`${REPO}/pulls`, () => HttpResponse.json([])),
    http.post(`${REPO}/pulls`, () =>
      HttpResponse.json(
        { number: 7, html_url: "https://github.com/acme/private/pull/7" },
        { status: 201 },
      ),
    ),
  );
  return seen;
}

const pull = (dir: string) =>
  pullRepo({
    repo: "acme/private",
    dir,
    gatewayUrl: GATEWAY,
    connectorId: CONNECTOR,
  });

test("the checkout holds GitHub's own commit, with origin/HEAD and the default branch at it, and every file as committed", async () => {
  fakeGitHub();
  const dir = join(root, "repo");
  expect(await pull(dir)).toEqual({ branch: "trunk", sha: headSha });
  expect(git(dir, "rev-parse", "HEAD")).toBe(headSha);
  expect(git(dir, "rev-parse", "origin/HEAD")).toBe(headSha);
  expect(git(dir, "rev-parse", "refs/remotes/origin/trunk")).toBe(headSha);
  expect(git(dir, "rev-parse", "--abbrev-ref", "origin/HEAD")).toBe(
    "origin/trunk",
  );
  expect(git(dir, "symbolic-ref", "--short", "HEAD")).toBe("trunk");
  expect(git(dir, "remote", "get-url", "origin")).toBe(
    "https://github.com/acme/private.git",
  );
  expect(git(dir, "status", "--porcelain")).toBe("");
  expect(git(dir, "fsck", "--no-dangling")).not.toContain("error");
  expect(readFileSync(join(dir, "src/deep/a b.ts"), "utf8")).toBe(
    "export {};\n",
  );
  expect(lstatSync(join(dir, "run.sh")).mode & 0o111).not.toBe(0);
  expect(readlinkSync(join(dir, "link"))).toBe("README.md");
  expect(git(dir, "log", "-1", "--format=%an|%aI|%cI|%B")).toBe(
    git(remote, "log", "-1", "--format=%an|%aI|%cI|%B", "trunk"),
  );
});

test("a worktree branches from origin/HEAD as the runner's does, on GitHub's commit", async () => {
  fakeGitHub();
  const dir = join(root, "repo");
  await pull(dir);
  const tree = join(root, "wt");
  git(dir, "worktree", "add", "-b", "claude/agt_1", tree, "origin/HEAD");
  expect(git(tree, "rev-parse", "HEAD")).toBe(headSha);
  expect(git(tree, "merge-base", "origin/HEAD", "HEAD")).toBe(headSha);
});

test("publishing a branch from the checkout builds its first commit on GitHub's real commit, so the ref is created off the real history", async () => {
  const seen = fakeGitHub();
  const dir = join(root, "repo");
  await pull(dir);
  const tree = join(root, "wt");
  git(dir, "worktree", "add", "-b", "claude/agt_1", tree, "origin/HEAD");
  writeFileSync(join(tree, "new.txt"), "agent work\n");
  commitAs(tree, "agent change", "2026-10-31T10:00:00+00:00");
  const result = await publish({
    cwd: tree,
    gatewayUrl: GATEWAY,
    connectorId: CONNECTOR,
    title: "Agent change",
  });
  expect(result).toMatchObject({ base: "trunk", created: true });
  expect(seen.commits).toHaveLength(1);
  expect(seen.commits[0]?.parents).toEqual([headSha]);
  expect(seen.commits[0]?.tree).toBe("c".repeat(40));
  expect(seen.refs).toEqual([
    { ref: "refs/heads/claude/agt_1", sha: "d".repeat(40) },
  ]);
});

test("nothing outside the repo's REST endpoints is called, and no request carries a credential", async () => {
  const seen = fakeGitHub();
  let auth: string | null = "unset";
  server.use(
    http.get(REPO, ({ request }) => {
      auth = request.headers.get("authorization");
      return HttpResponse.json({ default_branch: "trunk" });
    }),
  );
  await pull(join(root, "repo"));
  expect(auth).toBeNull();
  expect(seen.urls.every((u) => u.includes("/repos/acme/private/"))).toBe(true);
});

test("a commit with no parent leaves no shallow file; one with parents is shallow, so its missing history is never walked", async () => {
  fakeGitHub();
  const dir = join(root, "repo");
  await pull(dir);
  expect(readFileSync(join(dir, ".git/shallow"), "utf8").trim()).toBe(headSha);
  expect(git(dir, "log", "--format=%H")).toBe(headSha);

  const solo = join(root, "solo");
  execFileSync("git", ["init", "-q", "-b", "trunk", solo]);
  writeFileSync(join(solo, "f"), "x\n");
  const only = commitAs(solo, "only", "2026-10-03T00:00:00+01:00");
  execFileSync("git", ["fetch", "-q", solo, "trunk:refs/heads/trunk", "-f"], {
    cwd: remote,
  });
  expect(bare("rev-parse", "trunk")).toBe(only);
  const dir2 = join(root, "repo2");
  await pull(dir2);
  expect(existsSync(join(dir2, ".git/shallow"))).toBe(false);
});

test("a commit whose sha can't be reproduced from the API fails the pull, naming it, rather than leaving a checkout that publishes off a sha GitHub lacks", async () => {
  fakeGitHub();
  server.use(
    http.get(`${REPO}/git/commits/:sha`, ({ params }) =>
      HttpResponse.json({
        ...apiCommit(String(params.sha)),
        message: "not what was committed",
      }),
    ),
  );
  await expect(pull(join(root, "repo"))).rejects.toThrow(
    `could not reproduce commit ${headSha}`,
  );
});

test("rebuildCommit finds the zone the API dropped, and gives up on a sha it can't match", () => {
  const commit = apiCommit(headSha);
  expect(rebuildCommit(headSha, commit)).toBe(
    `${bare("cat-file", "commit", headSha)}\n`,
  );
  expect(rebuildCommit("0".repeat(40), commit)).toBeNull();
});

test("repo-pull checks usage and the connector, then reports the commit it checked out", async () => {
  fakeGitHub();
  const io = { out: "", err: "" };
  const sink = {
    stdout: (s: string) => {
      io.out += s;
    },
    stderr: (s: string) => {
      io.err += s;
    },
  };
  expect(await repoPullMain(["acme"], {}, sink)).toBe(2);
  expect(io.err).toContain("usage: repo-pull");
  expect(await repoPullMain(["acme/private", join(root, "x")], {}, sink)).toBe(
    2,
  );
  expect(io.err).toContain("GITHUB_CONNECTOR is not set");
  const dir = join(root, "x");
  const env = { GITHUB_CONNECTOR: CONNECTOR, GITHUB_GATEWAY_URL: GATEWAY };
  expect(await repoPullMain(["acme/private", dir], env, sink)).toBe(0);
  expect(io.out).toBe(`repo pull: acme/private trunk at ${headSha}\n`);
  server.use(http.get(REPO, () => new HttpResponse("nope", { status: 404 })));
  expect(await repoPullMain(["acme/private", join(root, "y")], env, sink)).toBe(
    1,
  );
  expect(io.err).toContain("repo pull: failed:");
});
