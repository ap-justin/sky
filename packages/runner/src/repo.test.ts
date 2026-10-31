import { execFileSync, spawnSync } from "node:child_process";
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
import { DEFAULT_GATEWAY_URL, publish } from "./publish.js";
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
function fakeGitHub(base = REPO) {
  const seen = {
    commits: [] as { parents: string[]; tree: string; message: string }[],
    refs: [] as { ref: string; sha: string }[],
  };
  server.use(
    http.get(base, () => HttpResponse.json({ default_branch: "trunk" })),
    http.get(`${base}/git/ref/heads/trunk`, () =>
      HttpResponse.json({ object: { sha: bare("rev-parse", "trunk") } }),
    ),
    http.get(`${base}/git/commits/:sha`, ({ params }) =>
      HttpResponse.json(apiCommit(String(params.sha))),
    ),
    http.get(`${base}/git/trees/:sha`, ({ params }) =>
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
    http.get(`${base}/git/blobs/:sha`, ({ params }) => {
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
    http.get(`${base}/git/ref/*`, () =>
      HttpResponse.json({ message: "Not Found" }, { status: 404 }),
    ),
    // publish: its blobs are new to GitHub, its branch doesn't exist, no pull request is open
    http.post(`${base}/git/blobs`, () =>
      HttpResponse.json({ sha: "b".repeat(40) }, { status: 201 }),
    ),
    http.post(`${base}/git/trees`, () =>
      HttpResponse.json({ sha: "c".repeat(40) }, { status: 201 }),
    ),
    http.post(`${base}/git/commits`, async ({ request }) => {
      seen.commits.push((await request.json()) as never);
      return HttpResponse.json({ sha: "d".repeat(40) }, { status: 201 });
    }),
    http.post(`${base}/git/refs`, async ({ request }) => {
      seen.refs.push((await request.json()) as never);
      return HttpResponse.json({}, { status: 201 });
    }),
    http.get(`${base}/pulls`, () => HttpResponse.json([])),
    http.post(`${base}/pulls`, () =>
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
  expect(
    spawnSync("git", ["fsck", "--strict", "--no-dangling", "--no-progress"], {
      cwd: dir,
      encoding: "utf8",
    }),
  ).toMatchObject({ status: 0, stdout: "", stderr: "" });
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
  fakeGitHub();
  const requests: { url: string; auth: string | null }[] = [];
  server.use(
    http.all("*", ({ request }) => {
      requests.push({
        url: request.url,
        auth: request.headers.get("authorization"),
      });
    }),
  );
  await pull(join(root, "repo"));
  expect(requests.length).toBeGreaterThan(3);
  for (const { url, auth } of requests) {
    expect(url === REPO || url.startsWith(`${REPO}/`), url).toBe(true);
    expect(auth, url).toBeNull();
  }
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

test("an unsigned tip with a header the API leaves out fails the pull, naming the commit and why, rather than leaving a checkout that publishes off a sha GitHub lacks", async () => {
  fakeGitHub();
  const tip = rawTip(MERGETAG, false);
  const failure = pull(join(root, "repo"));
  await expect(failure).rejects.toThrow(
    `commit ${tip.sha} is unsigned and carries more than GitHub's API returns (a mergetag or encoding header`,
  );
  await expect(failure).rejects.toThrow("Move trunk to a commit");
});

test("a signed tip whose signed text doesn't hash to its sha fails the pull, saying so", async () => {
  fakeGitHub();
  const tip = rawTip([], true);
  server.use(
    http.get(`${REPO}/git/commits/:sha`, ({ params }) =>
      HttpResponse.json({
        ...apiCommit(String(params.sha)),
        verification: {
          verified: true,
          reason: "valid",
          signature: SIGNATURE,
          payload: tip.payload.replace("Ship it", "Ship it!"),
        },
      }),
    ),
  );
  await expect(pull(join(root, "repo"))).rejects.toThrow(
    `commit ${tip.sha} is signed, but its signed text from GitHub's API doesn't hash to it`,
  );
});

const SIGNATURE = [
  "-----BEGIN PGP SIGNATURE-----",
  "",
  "wsFcBAABCAAQBQJnAAAACRBK7hj4Ov3rIwAAdHIQAKw4Zm9vYmFy",
  "=abcd",
  "-----END PGP SIGNATURE-----",
  "",
].join("\n");

/**
 * Moves trunk to a commit written as raw text, as GitHub's web flow signs one: `headers` after the
 * committer, the signature as the last header. Returns its sha and the text that was signed.
 */
const rawTip = (headers: string[], signed: boolean) => {
  const tree = bare("rev-parse", `${headSha}^{tree}`);
  const lines = [
    `tree ${tree}`,
    `parent ${headSha}`,
    "author Ada L <ada@example.com> 1790000000 +0530",
    "committer GitHub <noreply@github.com> 1790000100 -0700",
    ...headers,
  ];
  const message = "Merge pull request #1 from acme/feature\n\nShip it\n";
  const payload = `${lines.join("\n")}\n\n${message}`;
  const gpgsig = `gpgsig ${SIGNATURE.replace(/\n$/, "").split("\n").join("\n ")}`;
  const text = signed
    ? `${[...lines, gpgsig].join("\n")}\n\n${message}`
    : payload;
  const sha = execFileSync(
    "git",
    ["hash-object", "-t", "commit", "-w", "--stdin"],
    { cwd: remote, input: text, encoding: "utf8" },
  ).trim();
  bare("update-ref", "refs/heads/trunk", sha);
  return { sha, payload };
};

const MERGETAG = [
  "mergetag object 0123456789012345678901234567890123456789",
  " type commit",
  " tag v1.0",
  " tagger Ada L <ada@example.com> 1789999000 +0000",
  " ",
  " v1.0",
];

test("a signed tip, as every web-UI merge is, checks out at GitHub's sha from the signed text the API gives, extra headers and all", async () => {
  fakeGitHub();
  const tip = rawTip([...MERGETAG, "encoding UTF-8"], true);
  server.use(
    http.get(`${REPO}/git/commits/:sha`, ({ params }) =>
      HttpResponse.json({
        ...apiCommit(String(params.sha)),
        verification: {
          verified: true,
          reason: "valid",
          signature: SIGNATURE,
          payload: tip.payload,
        },
      }),
    ),
  );
  const dir = join(root, "repo");
  expect(await pull(dir)).toEqual({ branch: "trunk", sha: tip.sha });
  expect(git(dir, "rev-parse", "HEAD")).toBe(tip.sha);
  expect(git(dir, "status", "--porcelain")).toBe("");
});

test("rebuildCommit finds the zone the API dropped, and gives up on a sha it can't match", () => {
  const commit = apiCommit(headSha);
  expect(rebuildCommit(headSha, commit)).toBe(
    `${bare("cat-file", "commit", headSha)}\n`,
  );
  expect(() => rebuildCommit("0".repeat(40), commit)).toThrow(
    `commit ${"0".repeat(40)} is unsigned`,
  );
});

const sinks = () => {
  const io = { out: "", err: "" };
  return {
    io,
    sink: {
      stdout: (s: string) => {
        io.out += s;
      },
      stderr: (s: string) => {
        io.err += s;
      },
    },
  };
};
const mainEnv = { GITHUB_CONNECTOR: CONNECTOR, GITHUB_GATEWAY_URL: GATEWAY };

test.each([
  ["no dir", ["acme/private"]],
  ["nothing", []],
  ["an extra argument", ["acme/private", "dir", "extra"]],
  ["a repo with a subpath", ["a/b/c", "dir"]],
  ["a repo with no owner", ["private", "dir"]],
  ["a repo with a blank owner", [" /private", "dir"]],
])(
  "repo-pull with %s is a usage error, exit 2, and touches nothing",
  async (_, argv) => {
    const { io, sink } = sinks();
    expect(await repoPullMain(argv, mainEnv, sink)).toBe(2);
    expect(io.err).toBe("usage: repo-pull <owner/repo> <dir>\n");
    expect(io.out).toBe("");
  },
);

test("repo-pull without a connector is a config error, exit 2, naming the variable", async () => {
  const { io, sink } = sinks();
  expect(await repoPullMain(["acme/private", join(root, "x")], {}, sink)).toBe(
    2,
  );
  expect(io.err).toBe("repo pull: GITHUB_CONNECTOR is not set\n");
  expect(existsSync(join(root, "x"))).toBe(false);
});

test("repo-pull reports the commit it checked out, on stdout", async () => {
  fakeGitHub();
  const { io, sink } = sinks();
  const dir = join(root, "x");
  expect(await repoPullMain(["acme/private", dir], mainEnv, sink)).toBe(0);
  expect(io.out).toBe(`repo pull: acme/private trunk at ${headSha}\n`);
  expect(git(dir, "rev-parse", "HEAD")).toBe(headSha);
});

test.each([
  ["unset", {}],
  ["empty", { GITHUB_GATEWAY_URL: "" }],
])(
  "repo-pull with the gateway URL %s goes to the default gateway",
  async (_, extra) => {
    fakeGitHub(`${DEFAULT_GATEWAY_URL}/${CONNECTOR}/repos/acme/private`);
    const { sink } = sinks();
    const dir = join(root, "x");
    const env = { GITHUB_CONNECTOR: CONNECTOR, ...extra };
    expect(await repoPullMain(["acme/private", dir], env, sink)).toBe(0);
    expect(git(dir, "rev-parse", "HEAD")).toBe(headSha);
  },
);

test("repo-pull of a repo the connector can't see is a failed pull, exit 1, with the cause on stderr", async () => {
  fakeGitHub();
  server.use(http.get(REPO, () => new HttpResponse("nope", { status: 404 })));
  const { io, sink } = sinks();
  expect(
    await repoPullMain(["acme/private", join(root, "y")], mainEnv, sink),
  ).toBe(1);
  expect(io.err).toContain(
    "repo pull: failed: the connector in GITHUB_CONNECTOR can't see acme/private; check its connection id and the repos it grants",
  );
  expect(io.out).toBe("");
});

test("a relative dir is taken from the working directory, as a shell gives it", async () => {
  fakeGitHub();
  const cwd = process.cwd();
  process.chdir(root);
  try {
    await pull("rel/repo");
  } finally {
    process.chdir(cwd);
  }
  const dir = join(root, "rel/repo");
  expect(git(dir, "rev-parse", "HEAD")).toBe(headSha);
  expect(git(dir, "status", "--porcelain")).toBe("");
});

test("a re-run onto the checkout a killed run left behind, origin and all, finishes it", async () => {
  fakeGitHub();
  const dir = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "trunk", dir]);
  git(dir, "remote", "add", "origin", "https://github.com/acme/private.git");
  writeFileSync(join(dir, ".git/shallow"), `${"e".repeat(40)}\n`);
  expect(await pull(dir)).toEqual({ branch: "trunk", sha: headSha });
  expect(git(dir, "rev-parse", "origin/HEAD")).toBe(headSha);
  expect(git(dir, "config", "--get-all", "remote.origin.fetch")).toBe(
    "+refs/heads/*:refs/remotes/origin/*",
  );
  expect(readFileSync(join(dir, ".git/shallow"), "utf8")).toBe(`${headSha}\n`);
  expect(git(dir, "status", "--porcelain")).toBe("");
});

test("a pull that fails part-way removes the checkout it started, so the next run starts clean", async () => {
  fakeGitHub();
  server.use(
    http.get(`${REPO}/git/blobs/:sha`, () =>
      HttpResponse.json({ message: "Server Error" }, { status: 500 }),
    ),
  );
  const parent = join(root, "fresh");
  const dir = join(parent, "repo");
  await expect(pull(dir)).rejects.toThrow("returned 500");
  expect(existsSync(parent)).toBe(false);

  const kept = join(root, "kept");
  mkdirSync(kept);
  writeFileSync(join(kept, "notes.txt"), "mine\n");
  await expect(pull(kept)).rejects.toThrow("returned 500");
  expect(existsSync(join(kept, ".git"))).toBe(false);
  expect(readFileSync(join(kept, "notes.txt"), "utf8")).toBe("mine\n");
});

test("an empty repo fails the pull saying it's empty, not with the gateway's 409", async () => {
  fakeGitHub();
  server.use(
    http.get(`${REPO}/git/ref/heads/trunk`, () =>
      HttpResponse.json(
        { message: "Git Repository is empty." },
        { status: 409 },
      ),
    ),
  );
  await expect(pull(join(root, "repo"))).rejects.toThrow(
    "acme/private is empty: its default branch has no commit to check out; push one first",
  );
});

/** Pushes a new commit on trunk after `edit` changes a clone of it; returns the new tip. */
const advanceTrunk = (edit: (work: string) => void) => {
  const work = join(root, "work");
  execFileSync("git", ["clone", "-q", "-b", "trunk", remote, work]);
  edit(work);
  const sha = commitAs(work, "more", "2026-10-05T12:00:00+02:00");
  git(work, "push", "-q", "origin", "trunk");
  return sha;
};

test("a truncated tree fails the pull as too large, and leaves nothing behind", async () => {
  fakeGitHub();
  server.use(
    http.get(`${REPO}/git/trees/:sha`, () =>
      HttpResponse.json({ truncated: true, tree: [] }),
    ),
  );
  const dir = join(root, "fresh/repo");
  await expect(pull(dir)).rejects.toThrow(
    "the tree of acme/private is too large to fetch",
  );
  expect(existsSync(join(root, "fresh"))).toBe(false);
});

test("a blob GitHub 404s mid-fetch fails the pull naming the status, and removes the checkout", async () => {
  fakeGitHub();
  server.use(
    http.get(`${REPO}/git/blobs/:sha`, () =>
      HttpResponse.json({ message: "Not Found" }, { status: 404 }),
    ),
  );
  const dir = join(root, "fresh/repo");
  await expect(pull(dir)).rejects.toThrow("404");
  expect(existsSync(join(root, "fresh"))).toBe(false);
});

test("a tree whose entries rebuild a different tree sha fails the pull, naming both, and removes the checkout", async () => {
  fakeGitHub();
  const readme = bare("rev-parse", `${headSha}:README.md`);
  const script = bare("rev-parse", `${headSha}:run.sh`);
  const real = bare("rev-parse", `${headSha}^{tree}`);
  server.use(
    http.get(`${REPO}/git/trees/:sha`, () =>
      HttpResponse.json({
        truncated: false,
        tree: bare("ls-tree", "-r", "-z", real)
          .split("\0")
          .filter(Boolean)
          .map((line) => {
            const [meta = "", path = ""] = line.split("\t");
            const [mode, type, sha] = meta.split(" ");
            // run.sh arrives with README's content
            return { mode, type, sha: sha === script ? readme : sha, path };
          }),
      }),
    ),
  );
  const dir = join(root, "fresh/repo");
  const failure = await pull(dir).catch((error: Error) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(
    new RegExp(`^tree ${real} arrived as [0-9a-f]{40}$`),
  );
  expect(existsSync(join(root, "fresh"))).toBe(false);
});

test("a submodule's gitlink entry is kept in the tree as a gitlink, with no fetch of its commit", async () => {
  let linked = "";
  const tip = advanceTrunk((work) => {
    const sub = join(work, "vendor/sub");
    mkdirSync(sub, { recursive: true });
    execFileSync("git", ["init", "-q", sub]);
    writeFileSync(join(sub, "f"), "x\n");
    linked = commitAs(sub, "sub", "2026-10-04T00:00:00+00:00");
  });
  expect(bare("ls-tree", tip, "vendor/sub")).toContain(
    `160000 commit ${linked}`,
  );
  fakeGitHub();
  const dir = join(root, "repo");
  expect(await pull(dir)).toEqual({ branch: "trunk", sha: tip });
  expect(git(dir, "ls-tree", "HEAD", "vendor/sub")).toBe(
    `160000 commit ${linked}\tvendor/sub`,
  );
  expect(git(dir, "rev-parse", "HEAD^{tree}")).toBe(
    bare("rev-parse", `${tip}^{tree}`),
  );
});

test("binary, empty and duplicated blobs arrive byte for byte, one fetch per distinct blob", async () => {
  const binary = Buffer.from([0, 255, 10, 13, 0x80, 0, 1]);
  const tip = advanceTrunk((work) => {
    writeFileSync(join(work, "a.bin"), binary);
    writeFileSync(join(work, "copy.bin"), binary);
    writeFileSync(join(work, "empty.txt"), "");
    writeFileSync(join(work, "dup.txt"), "private\n");
  });
  fakeGitHub();
  const fetched: string[] = [];
  server.use(
    http.get(`${REPO}/git/blobs/:sha`, ({ params }) => {
      fetched.push(String(params.sha));
      const content = execFileSync(
        "git",
        ["cat-file", "blob", String(params.sha)],
        { cwd: remote },
      );
      return HttpResponse.json({
        encoding: "base64",
        content: content.toString("base64"),
      });
    }),
  );
  const dir = join(root, "repo");
  await pull(dir);
  expect(git(dir, "ls-tree", "-r", "HEAD")).toBe(bare("ls-tree", "-r", tip));
  expect(readFileSync(join(dir, "a.bin")).equals(binary)).toBe(true);
  expect(readFileSync(join(dir, "copy.bin")).equals(binary)).toBe(true);
  expect(readFileSync(join(dir, "empty.txt"))).toHaveLength(0);
  expect(readFileSync(join(dir, "dup.txt"), "utf8")).toBe("private\n");
  expect(new Set(fetched).size).toBe(fetched.length);
  expect(git(dir, "status", "--porcelain")).toBe("");
});

test("a default branch with a slash is checked out under that name, with origin/HEAD at it", async () => {
  fakeGitHub();
  const sha = bare("rev-parse", "trunk");
  server.use(
    http.get(REPO, () => HttpResponse.json({ default_branch: "release/1.0" })),
    http.get(`${REPO}/git/ref/heads/release/1.0`, () =>
      HttpResponse.json({ object: { sha } }),
    ),
  );
  const dir = join(root, "repo");
  expect(await pull(dir)).toEqual({ branch: "release/1.0", sha });
  expect(git(dir, "symbolic-ref", "--short", "HEAD")).toBe("release/1.0");
  expect(git(dir, "rev-parse", "--abbrev-ref", "origin/HEAD")).toBe(
    "origin/release/1.0",
  );
  expect(git(dir, "config", "branch.release/1.0.merge")).toBe(
    "refs/heads/release/1.0",
  );
});
