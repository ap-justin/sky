import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { server } from "../../../test/msw.js";
import { tarballFaults } from "../../../test/tarball-faults.js";
import {
  pullStore,
  pushStore,
  storeSyncMain,
  syncStoreQuietly,
  TARBALL_MIN_BLOBS,
  underLock,
} from "./store.js";

const GATEWAY = "https://gateway.test/v1/gateway/github";
const CONNECTOR = "conn_123";
const REPO = `${GATEWAY}/${CONNECTOR}/repos/acme/store`;
const CODELOAD = "https://codeload.test/acme/store/legacy.tar.gz";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const gitIn = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();

let root: string;
let remote: string;
let home: string;
let hub: ReturnType<typeof fakeGitHub>;

/** Adds a commit on the fake GitHub's main, as another machine pushing would; `null` deletes. */
function pushElsewhere(
  files: Record<string, string | null>,
  message = "elsewhere",
) {
  const clone = join(root, `elsewhere-${Math.random().toString(36).slice(2)}`);
  execFileSync("git", ["clone", "-q", remote, clone]);
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      rmSync(join(clone, path));
      continue;
    }
    mkdirSync(dirname(join(clone, path)), { recursive: true });
    writeFileSync(join(clone, path), content);
  }
  git(clone, "add", "--all");
  git(
    clone,
    "-c",
    "user.name=other",
    "-c",
    "user.email=o@x",
    "commit",
    "-qm",
    message,
  );
  git(clone, "push", "-q", "origin", "HEAD:main");
}

/**
 * GitHub's git data API for one repo, backed by a real bare repository so shas, trees and
 * fast-forward checks behave as GitHub's do. `racing` advances main before a PATCH answers, as a
 * push from another machine landing in between would.
 */
function fakeGitHub(options: { racing?: () => boolean } = {}) {
  const state = {
    patches: 0,
    blobPosts: 0,
    blobGets: 0,
    tarballs: 0,
    commits: [] as unknown[],
  };
  const bare = (...args: string[]) => git(remote, ...args);
  server.use(
    http.get(REPO, () => HttpResponse.json({ default_branch: "main" })),
    http.get(`${REPO}/git/ref/heads/main`, () =>
      HttpResponse.json({
        object: { sha: bare("rev-parse", "refs/heads/main") },
      }),
    ),
    http.get(`${REPO}/git/commits/:sha`, ({ params }) =>
      HttpResponse.json({
        tree: { sha: bare("rev-parse", `${params.sha}^{tree}`) },
      }),
    ),
    http.get(`${REPO}/git/trees/:sha`, ({ params }) =>
      HttpResponse.json({
        truncated: false,
        // -z: GitHub answers real paths, never git's C-quoted ones
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
      state.blobGets++;
      return HttpResponse.json({
        encoding: "base64",
        content: execFileSync("git", ["cat-file", "blob", String(params.sha)], {
          cwd: remote,
        }).toString("base64"),
      });
    }),
    // GitHub answers the tarball with a redirect to a pre-signed codeload URL
    http.get(`${REPO}/tarball/:sha`, ({ params }) => {
      state.tarballs++;
      return new HttpResponse(null, {
        status: 302,
        headers: { location: `${CODELOAD}/${params.sha}` },
      });
    }),
    http.get(`${CODELOAD}/:sha`, ({ request, params }) => {
      expect(request.headers.get("authorization")).toBeNull();
      const sha = String(params.sha);
      return new HttpResponse(
        execFileSync(
          "git",
          ["archive", "--format=tar.gz", `--prefix=acme-store-${sha}/`, sha],
          { cwd: remote, maxBuffer: 64 * 1024 * 1024 },
        ),
        { headers: { "content-type": "application/x-gzip" } },
      );
    }),
    http.post(`${REPO}/git/blobs`, async ({ request }) => {
      state.blobPosts++;
      const { content } = (await request.json()) as { content: string };
      const sha = execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: remote,
        input: Buffer.from(content, "base64"),
      })
        .toString()
        .trim();
      return HttpResponse.json({ sha }, { status: 201 });
    }),
    http.post(`${REPO}/git/trees`, async ({ request }) => {
      const { tree, base_tree } = (await request.json()) as {
        tree: { mode: string; sha: string | null; path: string }[];
        base_tree?: string;
      };
      // the whole store's tree in one request is refused by GitHub, so only changes go up
      expect(base_tree).toBeDefined();
      const index = join(root, "gh-index");
      const env = { GIT_INDEX_FILE: index };
      execFileSync("rm", ["-f", index]);
      gitIn(remote, env, "read-tree", String(base_tree));
      for (const e of tree) {
        if (e.sha === null) {
          execFileSync("git", ["update-index", "--index-info"], {
            cwd: remote,
            env: { ...process.env, ...env },
            input: `0 ${"0".repeat(40)}\t${e.path}\n`,
          });
        } else {
          gitIn(
            remote,
            env,
            "update-index",
            "--add",
            "--cacheinfo",
            `${e.mode},${e.sha},${e.path}`,
          );
        }
      }
      return HttpResponse.json(
        { sha: gitIn(remote, env, "write-tree") },
        { status: 201 },
      );
    }),
    http.post(`${REPO}/git/commits`, async ({ request }) => {
      const body = (await request.json()) as {
        message: string;
        tree: string;
        parents: string[];
      };
      state.commits.push(body);
      const sha = bare(
        "-c",
        "user.name=github",
        "-c",
        "user.email=noreply@github.test",
        "commit-tree",
        body.tree,
        ...body.parents.flatMap((p) => ["-p", p]),
        "-m",
        body.message,
      );
      return HttpResponse.json({ sha }, { status: 201 });
    }),
    http.patch(`${REPO}/git/refs/heads/main`, async ({ request }) => {
      state.patches++;
      if (options.racing?.()) pushElsewhere({ [`race-${state.patches}`]: "x" });
      const { sha, force } = (await request.json()) as {
        sha: string;
        force: boolean;
      };
      expect(force).toBe(false);
      try {
        bare("merge-base", "--is-ancestor", "refs/heads/main", sha);
      } catch {
        return HttpResponse.json(
          { message: "Update is not a fast forward" },
          { status: 422 },
        );
      }
      bare("update-ref", "refs/heads/main", sha);
      return HttpResponse.json({ ref: "refs/heads/main" });
    }),
  );
  return state;
}

const options = () => ({
  home,
  repo: "acme/store",
  gatewayUrl: GATEWAY,
  connectorId: CONNECTOR,
  message: "agent agt_1 run run_1",
});
const onRemote = (path: string) => git(remote, "show", `main:${path}`);
const remoteFiles = () =>
  git(remote, "ls-tree", "-r", "-z", "--name-only", "main").replaceAll(
    "\0",
    "\n",
  );
const local = (path: string) => readFileSync(join(home, path), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-store-"));
  // a Kru plugin under the host's ~/.claude, its git config or an exported identity would change
  // which store home, merge driver and author these tests see
  mkdirSync(join(root, "home"));
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_SYSTEM", "/dev/null");
  for (const name of [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ])
    vi.stubEnv(name, undefined);
  remote = join(root, "remote.git");
  home = join(root, "kru");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const seed = join(root, "seed");
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  writeFileSync(join(seed, "inbox.md"), "one\ntwo\n");
  writeFileSync(join(seed, "TODOS.md"), "remote todos\n");
  mkdirSync(join(seed, "management/app"), { recursive: true });
  writeFileSync(join(seed, "management/app/plan.md"), "plan\n");
  git(seed, "add", "--all");
  git(
    seed,
    "-c",
    "user.name=s",
    "-c",
    "user.email=s@x",
    "commit",
    "-qm",
    "seed",
  );
  git(seed, "push", "-q", remote, "HEAD:main");
  hub = fakeGitHub();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

test("a pull checks the store out into a directory that does not exist yet", async () => {
  await pullStore(options());
  expect(local("inbox.md")).toBe("one\ntwo\n");
  expect(local("management/app/plan.md")).toBe("plan\n");
  expect(existsSync(join(home, ".git"))).toBe(true);
});

test("a pull merges files already in the directory into the checkout and commits them", async () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "refusals.jsonl"), '{"a":1}\n');
  writeFileSync(join(home, "inbox.md"), "one\nlocal line\n");
  mkdirSync(join(home, "audit"));
  writeFileSync(join(home, "audit/session.jsonl"), "hook state\n");

  await pullStore(options());

  expect(local("refusals.jsonl")).toBe('{"a":1}\n');
  // the line files merge: both sides' lines land
  expect(local("inbox.md")).toContain("local line");
  expect(local("inbox.md")).toContain("two");
  expect(local("TODOS.md")).toBe("remote todos\n");
  expect(git(home, "status", "--porcelain")).toBe("");
  // committed, hook state kept out
  expect(git(home, "ls-files")).toContain("refusals.jsonl");
  expect(git(home, "ls-files")).not.toContain("audit");
  expect(existsSync(join(home, "audit/session.jsonl"))).toBe(true);
});

test("a file edited on both sides keeps the local copy, and the remote's stays in history", async () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "TODOS.md"), "local todos\n");
  await pullStore(options());
  expect(local("TODOS.md")).toBe("local todos\n");
  const synced = git(home, "rev-parse", "refs/sky/synced");
  expect(git(home, "show", `${synced}:TODOS.md`)).toBe("remote todos");
});

test("a file deleted on the remote and edited here keeps the local copy, and sync goes on", async () => {
  await pullStore(options());
  pushElsewhere({ "management/app/plan.md": null });
  writeFileSync(join(home, "management/app/plan.md"), "plan\nmine\n");

  await pullStore(options());

  expect(local("management/app/plan.md")).toBe("plan\nmine\n");
  expect(git(home, "status", "--porcelain")).toBe("");
  pushElsewhere({ "new.md": "after\n" });
  expect(await pushStore(options())).toBe(true);
  expect(local("new.md")).toBe("after\n");
  expect(onRemote("management/app/plan.md")).toBe("plan\nmine");
});

test("a file deleted here and edited on the remote stays deleted, and sync goes on", async () => {
  await pullStore(options());
  pushElsewhere({ "management/app/plan.md": "plan\ntheirs\n" });
  rmSync(join(home, "management/app/plan.md"));

  await pullStore(options());

  expect(existsSync(join(home, "management/app/plan.md"))).toBe(false);
  expect(git(home, "status", "--porcelain")).toBe("");
  const synced = git(home, "rev-parse", "refs/sky/synced");
  expect(git(home, "show", `${synced}:management/app/plan.md`)).toBe(
    "plan\ntheirs",
  );
  expect(await pushStore(options())).toBe(true);
  expect(remoteFiles()).not.toContain("management/app/plan.md");
});

test("a file deleted on the remote and untouched here is removed locally", async () => {
  await pullStore(options());
  pushElsewhere({ "management/app/plan.md": null });

  await pullStore(options());

  expect(existsSync(join(home, "management/app/plan.md"))).toBe(false);
  expect(git(home, "status", "--porcelain")).toBe("");
});

test("pulling again changes nothing, and picks up what the remote gained", async () => {
  await pullStore(options());
  const head = git(home, "rev-parse", "HEAD");
  await pullStore(options());
  expect(git(home, "rev-parse", "HEAD")).toBe(head);

  pushElsewhere({ "new.md": "from elsewhere\n" });
  await pullStore(options());
  expect(local("new.md")).toBe("from elsewhere\n");
});

test("a directory that already is a git repo is carried over whole and its tip kept", async () => {
  mkdirSync(home, { recursive: true });
  git(home, "init", "-q", "-b", "main");
  writeFileSync(join(home, "mine.md"), "mine\n");
  git(home, "add", "--all");
  git(
    home,
    "-c",
    "user.name=m",
    "-c",
    "user.email=m@x",
    "commit",
    "-qm",
    "mine",
  );
  const tip = git(home, "rev-parse", "HEAD");

  await pullStore(options());

  expect(local("mine.md")).toBe("mine\n");
  expect(local("TODOS.md")).toBe("remote todos\n");
  expect(git(home, "rev-parse", "refs/sky/pre-sync")).toBe(tip);
});

const many = (count: number, prefix: string) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `${prefix}/${i}.md`,
      `${prefix} ${i}\n`,
    ]),
  );
const remoteBlob = (sha: string) =>
  execFileSync("git", ["cat-file", "blob", sha], { cwd: remote }).toString(
    "base64",
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// well under the tarball threshold even with the seed's three blobs, so a pull of this many goes blob by blob
const SOME = TARBALL_MIN_BLOBS - 20;
const distinctBlobs = () =>
  new Set(
    git(remote, "ls-tree", "-r", "main")
      .split("\n")
      .map((line) => line.split(/\s+/)[2]),
  ).size;

/** The tarball GitHub would serve for `sha`. */
const archive = (sha: string) =>
  execFileSync(
    "git",
    ["archive", "--format=tar.gz", `--prefix=acme-store-${sha}/`, sha],
    { cwd: remote, maxBuffer: 64 * 1024 * 1024 },
  );

/** Replaces what codeload answers for every tarball. */
const codeload = (answer: (archive: Buffer) => Response) =>
  server.use(
    http.get(`${CODELOAD}/:sha`, ({ params }) =>
      answer(archive(String(params.sha))),
    ),
  );

const refuseTarball = () =>
  server.use(
    http.get(`${REPO}/tarball/:sha`, () =>
      HttpResponse.json({ message: "tarball refused" }, { status: 403 }),
    ),
  );

test("a pull fetches missing blobs several at a time, never more than 8", async () => {
  pushElsewhere(many(SOME, "bulk"));
  let inFlight = 0;
  let peak = 0;
  let fetched = 0;
  server.use(
    http.get(`${REPO}/git/blobs/:sha`, async ({ params }) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(15);
      inFlight--;
      fetched++;
      return HttpResponse.json({
        encoding: "base64",
        content: remoteBlob(String(params.sha)),
      });
    }),
  );

  await pullStore(options());

  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(8);
  expect(fetched).toBe(SOME + 3);
  expect(hub.tarballs).toBe(0);
  for (const [path, content] of Object.entries(many(SOME, "bulk")))
    expect(local(path)).toBe(content);
  expect(local("inbox.md")).toBe("one\ntwo\n");
  expect(git(home, "status", "--porcelain")).toBe("");
});

test("a pull missing 50 or more blobs takes them as one tarball, and the tree is GitHub's exactly", async () => {
  pushElsewhere(many(60, "bulk"));
  const lines: string[] = [];

  await pullStore({ ...options(), progress: (line) => lines.push(line) });

  expect(hub.tarballs).toBe(1);
  expect(hub.blobGets).toBe(0);
  for (const [path, content] of Object.entries(many(60, "bulk")))
    expect(local(path)).toBe(content);
  expect(git(home, "rev-parse", "refs/sky/synced^{tree}")).toBe(
    git(remote, "rev-parse", "main^{tree}"),
  );
  expect(git(home, "status", "--porcelain")).toBe("");
  // repo, ref, commit, tree, tarball
  expect(lines).toContain("store sync: pull used 5 GitHub API calls");
});

test("a pull missing fewer than 50 blobs fetches just those, without a tarball", async () => {
  await pullStore(options());
  hub.blobGets = 0;
  pushElsewhere(many(49, "few"));
  const lines: string[] = [];

  await pullStore({ ...options(), progress: (line) => lines.push(line) });

  expect(hub.tarballs).toBe(0);
  expect(hub.blobGets).toBe(49);
  expect(local("few/48.md")).toBe("few 48\n");
  // repo, ref, commit, tree, then a call per blob
  expect(lines).toContain("store sync: pull used 53 GitHub API calls");
});

test("a pull whose tarball is refused logs it naming the repo and the status, and fetches each blob instead", async () => {
  pushElsewhere(many(60, "bulk"));
  server.use(
    http.get(`${REPO}/tarball/:sha`, () =>
      HttpResponse.json(
        { message: "API rate limit exceeded" },
        { status: 403 },
      ),
    ),
  );
  const lines: string[] = [];

  await pullStore({ ...options(), progress: (line) => lines.push(line) });

  expect(lines.join("\n")).toMatch(
    /tarball of acme\/store at \w+ failed.*returned 403: API rate limit exceeded/,
  );
  expect(hub.blobGets).toBeGreaterThanOrEqual(60);
  expect(git(home, "rev-parse", "refs/sky/synced^{tree}")).toBe(
    git(remote, "rev-parse", "main^{tree}"),
  );
});

test("a pull missing exactly 50 blobs takes the tarball", async () => {
  await pullStore(options());
  hub.blobGets = 0;
  hub.tarballs = 0;
  pushElsewhere(many(50, "edge"));

  await pullStore(options());

  expect(hub.tarballs).toBe(1);
  expect(hub.blobGets).toBe(0);
  expect(local("edge/49.md")).toBe("edge 49\n");
});

test("a pull whose tarball and blobs both fail stops with the synced ref, the index and the working tree as they were", async () => {
  await pullStore(options());
  const synced = git(home, "rev-parse", "refs/sky/synced");
  writeFileSync(join(home, "inbox.md"), "one\ntwo\nmine\n");
  pushElsewhere(many(60, "bulk"));
  refuseTarball();
  server.use(
    http.get(`${REPO}/git/blobs/:sha`, () =>
      HttpResponse.json({ message: "Server Error" }, { status: 500 }),
    ),
  );

  await expect(pullStore(options())).rejects.toThrow("returned 500");

  expect(git(home, "rev-parse", "refs/sky/synced")).toBe(synced);
  expect(existsSync(join(home, ".git", "sky-sync-index"))).toBe(false);
  expect(existsSync(join(home, "bulk"))).toBe(false);
  expect(local("inbox.md")).toBe("one\ntwo\nmine\n");
  expect(git(home, "status", "--porcelain")).toBe("");
});

test.each(tarballFaults("remote todos"))(
  "a tarball that fails ($name) is logged and every blob is fetched alone, to the same tree",
  async (fault) => {
    pushElsewhere(many(60, "bulk"));
    fault.setup?.();
    codeload(fault.answer);
    const lines: string[] = [];

    await pullStore({ ...options(), progress: (line) => lines.push(line) });

    const fallback = lines.find((line) => line.includes("the tarball of"));
    expect(fallback).toMatch(
      /^store sync: the tarball of acme\/store at \w{40} failed, fetching its blobs one by one: /,
    );
    expect(fallback).toMatch(fault.cause);
    expect(hub.blobGets).toBe(distinctBlobs());
    expect(git(home, "rev-parse", "refs/sky/synced^{tree}")).toBe(
      git(remote, "rev-parse", "main^{tree}"),
    );
    for (const [path, content] of Object.entries(many(60, "bulk")))
      expect(local(path)).toBe(content);
    expect(git(home, "status", "--porcelain")).toBe("");
  },
);

test("a tarball entry whose bytes differ from the tree is never written, and its blob is fetched alone", async () => {
  pushElsewhere(many(60, "bulk"));
  codeload((real) => {
    const tar = gunzipSync(real);
    const at = tar.indexOf("bulk 7\n");
    expect(at).toBeGreaterThan(0);
    tar.write("bulk Z\n", at);
    return new HttpResponse(gzipSync(tar));
  });

  await pullStore(options());

  expect(hub.tarballs).toBe(1);
  // the rest of the 63 came from the tarball
  expect(hub.blobGets).toBe(1);
  expect(local("bulk/7.md")).toBe("bulk 7\n");
  expect(git(home, "rev-parse", "refs/sky/synced^{tree}")).toBe(
    git(remote, "rev-parse", "main^{tree}"),
  );
  const forged = execFileSync("git", ["hash-object", "--stdin"], {
    cwd: home,
    input: "bulk Z\n",
    encoding: "utf8",
  }).trim();
  expect(() => git(home, "cat-file", "-e", forged)).toThrow();
});

test("a blob that arrives with the wrong content fails the pull, and no new fetch starts after it", async () => {
  pushElsewhere(many(SOME, "bulk"));
  let started = 0;
  let inFlight = 0;
  server.use(
    http.get(`${REPO}/git/blobs/:sha`, async ({ params }) => {
      const first = ++started === 1;
      inFlight++;
      // the bad blob answers at once; the rest are still in flight when the pull sees it
      if (!first) await sleep(100);
      inFlight--;
      return HttpResponse.json({
        encoding: "base64",
        content: first
          ? Buffer.from("tampered\n").toString("base64")
          : remoteBlob(String(params.sha)),
      });
    }),
  );

  await expect(pullStore(options())).rejects.toThrow("arrived as");

  // the first wave of 8 and nothing after it; every one of them finished before the rejection
  expect(hub.tarballs).toBe(0);
  expect(started).toBe(8);
  expect(inFlight).toBe(0);
  await sleep(250);
  expect(started).toBe(8);
  expect(existsSync(join(home, ".git", "sky-sync-index"))).toBe(false);
  expect(existsSync(join(home, "bulk/0.md"))).toBe(false);
});

test("a push sends the checkout as one commit on top of the remote's head", async () => {
  await pullStore(options());
  const before = git(remote, "rev-parse", "main");
  writeFileSync(join(home, "inbox.md"), "one\ntwo\nthree\n");
  writeFileSync(join(home, "added.md"), "added\n");
  mkdirSync(join(home, "lead-gate"));
  writeFileSync(join(home, "lead-gate/x"), "state\n");
  execFileSync("rm", [join(home, "TODOS.md")]);

  expect(await pushStore(options())).toBe(true);

  expect(git(remote, "rev-parse", "main^")).toBe(before);
  expect(onRemote("inbox.md")).toBe("one\ntwo\nthree");
  expect(onRemote("added.md")).toBe("added");
  expect(remoteFiles()).not.toContain("TODOS.md");
  expect(remoteFiles()).not.toContain("lead-gate");
  expect(git(remote, "log", "-1", "--format=%s", "main")).toBe(
    "agent agt_1 run run_1",
  );
  // unchanged blobs were not uploaded again
  expect(hub.blobPosts).toBe(2);
});

test("non-ASCII and quoted file names keep their names both ways", async () => {
  await pullStore(options());
  writeFileSync(join(home, "café.md"), "mine\n");
  pushElsewhere({ "thé.md": "theirs\n", '"quoted".md': "quoted\n" });

  expect(await pushStore(options())).toBe(true);

  expect(local("thé.md")).toBe("theirs\n");
  expect(local('"quoted".md')).toBe("quoted\n");
  expect(onRemote("café.md")).toBe("mine");
  expect(remoteFiles().split("\n")).toContain("café.md");
});

test("a push with nothing new sends nothing", async () => {
  await pullStore(options());
  const before = git(remote, "rev-parse", "main");
  expect(await pushStore(options())).toBe(false);
  expect(git(remote, "rev-parse", "main")).toBe(before);
  expect(hub.patches).toBe(0);
});

test("a push the remote outran pulls, rebases and pushes again", async () => {
  server.resetHandlers();
  let raced = false;
  hub = fakeGitHub({
    racing: () => {
      const first = !raced;
      raced = true;
      return first;
    },
  });
  await pullStore(options());
  writeFileSync(join(home, "inbox.md"), "one\ntwo\nmine\n");

  expect(await pushStore(options())).toBe(true);

  expect(hub.patches).toBe(2);
  expect(remoteFiles()).toContain("race-1");
  expect(onRemote("inbox.md")).toBe("one\ntwo\nmine");
});

test("each pull of a push's retries counts only its own API calls", async () => {
  server.resetHandlers();
  let raced = false;
  hub = fakeGitHub({
    racing: () => {
      const first = !raced;
      raced = true;
      return first;
    },
  });
  await pullStore(options());
  writeFileSync(join(home, "inbox.md"), "one\ntwo\nmine\n");
  const lines: string[] = [];

  await pushStore({ ...options(), progress: (line) => lines.push(line) });

  // repo and ref, the remote unmoved; then after the race repo, ref, commit, tree and race-1's blob
  expect(lines.filter((line) => line.includes("pull used"))).toEqual([
    "store sync: pull used 2 GitHub API calls",
    "store sync: pull used 5 GitHub API calls",
  ]);
});

test("a push that keeps losing the race gives up with an error", async () => {
  server.resetHandlers();
  hub = fakeGitHub({ racing: () => true });
  await pullStore(options());
  writeFileSync(join(home, "added.md"), "added\n");

  await expect(pushStore(options())).rejects.toThrow(
    "the store moved on GitHub 4 times while pushing",
  );
  expect(hub.patches).toBe(4);
  // what the agent wrote is still in the checkout, committed
  expect(local("added.md")).toBe("added\n");
  expect(git(home, "status", "--porcelain")).toBe("");
});

test("a ref update GitHub refuses for any other reason fails at once with its message", async () => {
  await pullStore(options());
  writeFileSync(join(home, "added.md"), "added\n");
  let patches = 0;
  server.use(
    http.patch(`${REPO}/git/refs/heads/main`, () => {
      patches++;
      return HttpResponse.json(
        { message: "Reference cannot be updated" },
        { status: 422 },
      );
    }),
  );

  const pushed = pushStore(options());

  await expect(pushed).rejects.toThrow("Reference cannot be updated");
  await expect(pushed).rejects.not.toThrow("moved on GitHub");
  expect(patches).toBe(1);
});

test("two syncs on one store take the lock in turn", async () => {
  mkdirSync(home, { recursive: true });
  const log = join(root, "lock.log");
  const script = join(root, "hold.sh");
  writeFileSync(
    script,
    `echo "in $*" >> ${log}; sleep 0.4; echo "out $*" >> ${log}\n`,
  );
  const io = { stdout: () => {}, stderr: () => {} };
  const codes = await Promise.all([
    underLock(home, "pull", io, ["bash", script]),
    underLock(home, "push", io, ["bash", script]),
  ]);
  expect(codes).toEqual([0, 0]);
  const lines = readFileSync(log, "utf8").trim().split("\n");
  expect(lines).toHaveLength(4);
  // each one's "in" is followed by its own "out" before the other starts
  expect(lines[0]?.replace("in", "out")).toBe(lines[1]);
  expect(lines[2]?.replace("in", "out")).toBe(lines[3]);
  // the argv underLock builds: the runner's `store-sync <mode> --locked`
  expect(lines.filter((l) => l.startsWith("in ")).sort()).toEqual([
    "in store-sync pull --locked",
    "in store-sync push --locked",
  ]);
});

test("a sync that waits out the lock says so, and exits 1", async () => {
  mkdirSync(home, { recursive: true });
  const held = join(root, "held");
  const script = join(root, "hold.sh");
  writeFileSync(script, `touch ${held}; sleep 2\n`);
  const quiet = { stdout: () => {}, stderr: () => {} };
  const holder = underLock(home, "push", quiet, ["bash", script]);
  while (!existsSync(held)) await new Promise((r) => setTimeout(r, 20));
  let stderr = "";
  const waiter = { stdout: () => {}, stderr: (s: string) => (stderr += s) };

  expect(await underLock(home, "pull", waiter, ["true"], 1)).toBe(1);

  expect(stderr).toContain("lock");
  expect(stderr).toContain("1s");
  expect(stderr).not.toContain("exited");
  await holder;
});

const io = () => {
  const out = { stderr: "" };
  return {
    out,
    io: { stdout: () => {}, stderr: (s: string) => (out.stderr += s) },
  };
};

test("store-sync does nothing without a store repo or with the kill switch on", async () => {
  const env = { KRU_HOME: home, GITHUB_CONNECTOR: CONNECTOR };
  const quiet = io();
  expect(await storeSyncMain(["push"], env, quiet.io)).toBe(0);
  expect(
    await storeSyncMain(
      ["push"],
      { ...env, KRU_STORE_REPO: "acme/store", KRU_NO_STORE_SYNC: "1" },
      quiet.io,
    ),
  ).toBe(0);
  expect(quiet.out.stderr).toBe("");
  expect(existsSync(home)).toBe(false);
});

test("store-sync names the missing connector, and a bad mode", async () => {
  const a = io();
  expect(
    await storeSyncMain(["pull"], { KRU_STORE_REPO: "acme/store" }, a.io),
  ).toBe(2);
  expect(a.out.stderr).toContain("GITHUB_CONNECTOR is not set");
  const b = io();
  expect(await storeSyncMain(["sideways"], {}, b.io)).toBe(2);
  expect(b.out.stderr).toContain("usage: store-sync <pull|push>");
});

test("a pull that downloads blobs reports its progress on stderr, and one with nothing to fetch names only its API calls", async () => {
  pushElsewhere(many(250, "bulk"));
  const env = {
    KRU_HOME: home,
    KRU_STORE_REPO: "acme/store",
    GITHUB_CONNECTOR: CONNECTOR,
    GITHUB_GATEWAY_URL: GATEWAY,
  };
  const first = io();

  expect(await storeSyncMain(["pull", "--locked"], env, first.io)).toBe(0);

  expect(first.out.stderr).toBe(
    [
      "store sync: fetching 253 of 253 blobs",
      "store sync: 253 blobs from one tarball",
      "store sync: pull used 5 GitHub API calls",
      "",
    ].join("\n"),
  );

  pushElsewhere({ "new.md": "new\n" });
  const second = io();
  expect(await storeSyncMain(["pull", "--locked"], env, second.io)).toBe(0);
  expect(second.out.stderr).toBe(
    "store sync: fetching 1 of 254 blobs\nstore sync: fetched 1/1 blobs\nstore sync: pull used 5 GitHub API calls\n",
  );

  pushElsewhere({ "new.md": null });
  const third = io();
  expect(await storeSyncMain(["pull", "--locked"], env, third.io)).toBe(0);
  expect(third.out.stderr).toBe("store sync: pull used 4 GitHub API calls\n");
});

test("a sync that fails is logged and never thrown", async () => {
  server.use(http.get(REPO, () => new HttpResponse("down", { status: 500 })));
  const env = {
    KRU_HOME: home,
    KRU_STORE_REPO: "acme/store",
    GITHUB_CONNECTOR: CONNECTOR,
    GITHUB_GATEWAY_URL: GATEWAY,
  };
  const failed = io();
  expect(await storeSyncMain(["pull", "--locked"], env, failed.io)).toBe(1);
  expect(failed.out.stderr).toContain("pull failed");

  const warnings: string[] = [];
  await syncStoreQuietly("push", { KRU_HOME: home }, (l) => warnings.push(l));
  expect(warnings).toEqual([]);
  await syncStoreQuietly(
    "push",
    { KRU_HOME: home, KRU_STORE_REPO: "acme/store" },
    (l) => warnings.push(l),
  );
  expect(warnings.join()).toContain("GITHUB_CONNECTOR is not set");
});
