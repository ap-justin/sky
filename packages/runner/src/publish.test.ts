import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test } from "vitest";
import { server } from "../../../test/msw.js";
import { GatewayError, publish, publishMain } from "./publish.js";

const GATEWAY = "https://gateway.test/v1/gateway/github";
const CONNECTOR = "conn_123";
const REPO = `${GATEWAY}/${CONNECTOR}/repos/acme/widgets`;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let root: string;
let work: string;
let baseSha: string;

const commit = (message: string, date = "2026-10-30T12:00:00+02:00") => {
  git(work, "add", "--all");
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Claude",
      "-c",
      "user.email=noreply@anthropic.com",
      "commit",
      "-qm",
      message,
    ],
    {
      cwd: work,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    },
  );
  return git(work, "rev-parse", "HEAD");
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-publish-"));
  const origin = join(root, "origin");
  work = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  writeFileSync(join(origin, "README"), "hi\n");
  writeFileSync(join(origin, "old.txt"), "going away\n");
  git(origin, "add", ".");
  git(
    origin,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "init",
  );
  execFileSync("git", ["clone", "-q", origin, work]);
  git(
    work,
    "remote",
    "set-url",
    "origin",
    "https://github.com/acme/widgets.git",
  );
  git(work, "checkout", "-qb", "claude/agt_1");
  baseSha = git(work, "rev-parse", "HEAD");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Pull = { number: number; html_url: string; head: string; base: string };

/** GitHub's git data and pulls API behind the gateway, recording every request it answers. */
function fakeGitHub(options: { ref?: string; pulls?: Pull[] } = {}) {
  const state = {
    ref: options.ref,
    pulls: options.pulls ?? [],
    blobs: [] as { content: string; encoding: string }[],
    trees: [] as { base_tree: string; tree: unknown[] }[],
    commits: [] as {
      message: string;
      tree: string;
      parents: string[];
      author: unknown;
      committer: unknown;
    }[],
    refWrites: [] as { method: string; body: unknown }[],
    pullCreates: [] as unknown[],
    authorization: [] as (string | null)[],
  };
  const seen = (request: Request) =>
    state.authorization.push(request.headers.get("authorization"));
  server.use(
    http.post(`${REPO}/git/blobs`, async ({ request }) => {
      seen(request);
      state.blobs.push((await request.json()) as never);
      return HttpResponse.json(
        { sha: `blob${state.blobs.length}` },
        { status: 201 },
      );
    }),
    http.post(`${REPO}/git/trees`, async ({ request }) => {
      seen(request);
      state.trees.push((await request.json()) as never);
      return HttpResponse.json(
        { sha: `tree${state.trees.length}` },
        { status: 201 },
      );
    }),
    http.post(`${REPO}/git/commits`, async ({ request }) => {
      seen(request);
      state.commits.push((await request.json()) as never);
      return HttpResponse.json(
        { sha: `commit${state.commits.length}` },
        { status: 201 },
      );
    }),
    http.get(`${REPO}/git/ref/heads/claude/agt_1`, ({ request }) => {
      seen(request);
      return state.ref
        ? HttpResponse.json({
            ref: "refs/heads/claude/agt_1",
            object: { sha: state.ref, type: "commit" },
          })
        : HttpResponse.json({ message: "Not Found" }, { status: 404 });
    }),
    http.post(`${REPO}/git/refs`, async ({ request }) => {
      seen(request);
      const body = (await request.json()) as { sha: string };
      state.refWrites.push({ method: "POST", body });
      state.ref = body.sha;
      return HttpResponse.json({ object: { sha: body.sha } }, { status: 201 });
    }),
    http.patch(`${REPO}/git/refs/heads/claude/agt_1`, async ({ request }) => {
      seen(request);
      const body = (await request.json()) as { sha: string };
      state.refWrites.push({ method: "PATCH", body });
      state.ref = body.sha;
      return HttpResponse.json({ object: { sha: body.sha } });
    }),
    http.get(`${REPO}/pulls`, ({ request }) => {
      seen(request);
      const url = new URL(request.url);
      expect(url.searchParams.get("state")).toBe("open");
      const head = url.searchParams.get("head");
      return HttpResponse.json(
        state.pulls.filter((p) => `acme:${p.head}` === head),
      );
    }),
    http.post(`${REPO}/pulls`, async ({ request }) => {
      seen(request);
      const body = (await request.json()) as { head: string; base: string };
      state.pullCreates.push(body);
      const pull = {
        number: 7,
        html_url: "https://github.com/acme/widgets/pull/7",
        head: body.head,
        base: body.base,
      };
      state.pulls.push(pull);
      return HttpResponse.json(pull, { status: 201 });
    }),
  );
  return state;
}

const run = (extra: { title?: string; body?: string } = {}) =>
  publish({
    cwd: work,
    gatewayUrl: GATEWAY,
    connectorId: CONNECTOR,
    title: "Add widgets",
    ...extra,
  });

const b64 = (s: string) => Buffer.from(s).toString("base64");

test("a new branch: each commit becomes blobs, a tree on the base tree and a commit, then the ref is created and a PR opened", async () => {
  const gh = fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a\n\nWith a body.");
  writeFileSync(join(work, "run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(work, "run.sh"), 0o755);
  symlinkSync("a.txt", join(work, "link"));
  commit("Add a script and a link", "2026-10-30T13:00:00+00:00");

  const result = await run({ body: "Details here." });

  expect(gh.blobs).toEqual([
    { content: b64("first\n"), encoding: "base64" },
    { content: b64("a.txt"), encoding: "base64" },
    { content: b64("#!/bin/sh\necho hi\n"), encoding: "base64" },
  ]);
  const baseTree = git(work, "rev-parse", `${baseSha}^{tree}`);
  expect(gh.trees).toEqual([
    {
      base_tree: baseTree,
      tree: [{ path: "a.txt", mode: "100644", type: "blob", sha: "blob1" }],
    },
    {
      base_tree: "tree1",
      tree: expect.arrayContaining([
        { path: "link", mode: "120000", type: "blob", sha: "blob2" },
        { path: "run.sh", mode: "100755", type: "blob", sha: "blob3" },
      ]),
    },
  ]);
  const author = {
    name: "Claude",
    email: "noreply@anthropic.com",
    date: "2026-10-30T12:00:00+02:00",
  };
  expect(gh.commits).toEqual([
    {
      message: "Add a\n\nWith a body.\n",
      tree: "tree1",
      parents: [baseSha],
      author,
      committer: author,
    },
    {
      message: "Add a script and a link\n",
      tree: "tree2",
      parents: ["commit1"],
      author: { ...author, date: "2026-10-30T13:00:00+00:00" },
      committer: { ...author, date: "2026-10-30T13:00:00+00:00" },
    },
  ]);
  expect(gh.refWrites).toEqual([
    {
      method: "POST",
      body: { ref: "refs/heads/claude/agt_1", sha: "commit2" },
    },
  ]);
  expect(gh.pullCreates).toEqual([
    {
      title: "Add widgets",
      body: "Details here.",
      head: "claude/agt_1",
      base: "main",
    },
  ]);
  expect(result).toEqual({
    branch: "claude/agt_1",
    base: "main",
    sha: "commit2",
    created: true,
    pullRequest: { number: 7, url: "https://github.com/acme/widgets/pull/7" },
  });
  // the gateway injects the credential; the helper never sends one
  expect(new Set(gh.authorization)).toEqual(new Set([null]));
});

test("an existing ref is fast-forwarded with force off, replaying only the commits GitHub lacks", async () => {
  writeFileSync(join(work, "a.txt"), "first\n");
  const first = commit("Add a");
  writeFileSync(join(work, "b.txt"), "second\n");
  commit("Add b");
  const gh = fakeGitHub({ ref: first });

  const result = await run();

  expect(gh.blobs).toEqual([{ content: b64("second\n"), encoding: "base64" }]);
  expect(gh.trees).toEqual([
    {
      base_tree: git(work, "rev-parse", `${first}^{tree}`),
      tree: [{ path: "b.txt", mode: "100644", type: "blob", sha: "blob1" }],
    },
  ]);
  expect(gh.commits.map((c) => c.parents)).toEqual([[first]]);
  expect(gh.refWrites).toEqual([
    { method: "PATCH", body: { sha: "commit1", force: false } },
  ]);
  expect(result.sha).toBe("commit1");
});

test("an open PR for the branch is returned, not duplicated", async () => {
  const gh = fakeGitHub({
    pulls: [
      {
        number: 3,
        html_url: "https://github.com/acme/widgets/pull/3",
        head: "claude/agt_1",
        base: "main",
      },
    ],
  });
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  const result = await run();

  expect(gh.pullCreates).toEqual([]);
  expect(result).toMatchObject({
    created: false,
    pullRequest: { number: 3, url: "https://github.com/acme/widgets/pull/3" },
  });
});

test("a deleted file is a tree entry with a null sha", async () => {
  const gh = fakeGitHub();
  unlinkSync(join(work, "old.txt"));
  commit("Remove old");

  await run();

  expect(gh.blobs).toEqual([]);
  expect(gh.trees[0]?.tree).toEqual([
    { path: "old.txt", mode: "100644", type: "blob", sha: null },
  ]);
});

test("a gateway error names the call, the status and GitHub's message", async () => {
  fakeGitHub();
  server.use(
    http.post(`${REPO}/git/blobs`, () =>
      HttpResponse.json(
        { message: "Resource not accessible by integration" },
        { status: 403 },
      ),
    ),
  );
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");

  const error = await run().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(GatewayError);
  expect((error as Error).message).toBe(
    "GitHub gateway: POST /repos/acme/widgets/git/blobs returned 403: Resource not accessible by integration",
  );
});

test("a branch with no commits past its base, or with uncommitted changes, publishes nothing", async () => {
  await expect(run()).rejects.toThrow(/no commits on claude\/agt_1 past main/);
  writeFileSync(join(work, "a.txt"), "draft\n");
  await expect(run()).rejects.toThrow(/uncommitted changes/);
});

test("the publish command prints the PR URL, and without a connector exits 2 naming the secret to set", async () => {
  fakeGitHub();
  writeFileSync(join(work, "a.txt"), "first\n");
  commit("Add a");
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    cwd: work,
    stdout: (s: string) => void out.push(s),
    stderr: (s: string) => void err.push(s),
  };

  expect(await publishMain(["--title", "Add a"], {}, io)).toBe(2);
  expect(err.join("")).toContain(
    "sky secret set <env> GITHUB_CONNECTOR --connector=<connection id>",
  );

  const env = { GITHUB_CONNECTOR: CONNECTOR, GITHUB_GATEWAY_URL: GATEWAY };
  expect(await publishMain(["--title", "Add a"], env, io)).toBe(0);
  expect(out).toEqual(["https://github.com/acme/widgets/pull/7\n"]);
});
