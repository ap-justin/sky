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
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { server } from "../../../test/msw.js";
import {
  pullStore,
  pushStore,
  storeSyncMain,
  syncStoreQuietly,
  underLock,
} from "./store.js";

const GATEWAY = "https://gateway.test/v1/gateway/github";
const CONNECTOR = "conn_123";
const REPO = `${GATEWAY}/${CONNECTOR}/repos/acme/store`;

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
  const state = { patches: 0, blobPosts: 0, commits: [] as unknown[] };
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
    http.get(`${REPO}/git/blobs/:sha`, ({ params }) =>
      HttpResponse.json({
        encoding: "base64",
        content: execFileSync("git", ["cat-file", "blob", String(params.sha)], {
          cwd: remote,
        }).toString("base64"),
      }),
    ),
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
