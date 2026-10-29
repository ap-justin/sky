import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { commitAll, ensureWorktree } from "./worktree.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let root: string;
let origin: string;
let repoDir: string;
let worktreesDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-wt-"));
  origin = join(root, "origin");
  repoDir = join(root, "repo");
  worktreesDir = join(root, "worktrees");
  execFileSync("git", ["init", "-q", "-b", "trunk", origin]);
  writeFileSync(join(origin, "README"), "hi\n");
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
  execFileSync("git", ["clone", "-q", origin, repoDir]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("first run branches claude/<agentId> from the clone's default branch", async () => {
  const path = await ensureWorktree({
    repoDir,
    worktreesDir,
    agentId: "agt_1",
  });
  expect(path).toBe(join(worktreesDir, "agt_1"));
  expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("claude/agt_1");
  expect(git(path, "rev-parse", "HEAD")).toBe(
    git(origin, "rev-parse", "trunk"),
  );
});

test("a later run reuses the worktree and what's in it", async () => {
  const path = await ensureWorktree({
    repoDir,
    worktreesDir,
    agentId: "agt_1",
  });
  writeFileSync(join(path, "wip.txt"), "draft\n");
  expect(
    await ensureWorktree({ repoDir, worktreesDir, agentId: "agt_1" }),
  ).toBe(path);
  expect(existsSync(join(path, "wip.txt"))).toBe(true);
});

test("a branch whose worktree directory is gone is checked out again, keeping its commits", async () => {
  const path = await ensureWorktree({
    repoDir,
    worktreesDir,
    agentId: "agt_1",
  });
  writeFileSync(join(path, "a.txt"), "a\n");
  await commitAll({ cwd: path, agentId: "agt_1", runId: "run_1" });
  const head = git(path, "rev-parse", "HEAD");
  rmSync(path, { recursive: true, force: true });
  await ensureWorktree({ repoDir, worktreesDir, agentId: "agt_1" });
  expect(git(path, "rev-parse", "HEAD")).toBe(head);
});

test("commits every change on the agent branch as harness-agent, and never pushes", async () => {
  const path = await ensureWorktree({
    repoDir,
    worktreesDir,
    agentId: "agt_1",
  });
  writeFileSync(join(path, "new.txt"), "n\n");
  writeFileSync(join(path, "README"), "changed\n");
  expect(await commitAll({ cwd: path, agentId: "agt_1", runId: "run_7" })).toBe(
    true,
  );
  expect(git(path, "status", "--porcelain")).toBe("");
  expect(git(path, "log", "-1", "--format=%an <%ae>|%s")).toBe(
    "harness-agent <agent@harness.local>|agent agt_1 run run_7",
  );
  expect(git(origin, "branch", "--list", "claude/*")).toBe("");
});

test("a clean worktree makes no commit", async () => {
  const path = await ensureWorktree({
    repoDir,
    worktreesDir,
    agentId: "agt_1",
  });
  const head = git(path, "rev-parse", "HEAD");
  expect(await commitAll({ cwd: path, agentId: "agt_1", runId: "run_1" })).toBe(
    false,
  );
  expect(git(path, "rev-parse", "HEAD")).toBe(head);
});
