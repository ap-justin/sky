import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { type AgentId, agentBranch } from "@harness/shared";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/** The agent's worktree on `claude/<agentId>`, created from the clone's `origin/HEAD` on first use. */
export async function ensureWorktree(options: {
  repoDir: string;
  worktreesDir: string;
  agentId: AgentId;
}): Promise<string> {
  const branch = agentBranch(options.agentId);
  const path = join(options.worktreesDir, options.agentId);
  if (existsSync(path)) {
    const head = await git(path, "rev-parse", "--abbrev-ref", "HEAD");
    if (head !== branch) {
      throw new Error(`worktree ${path} is on ${head}, expected ${branch}`);
    }
    return path;
  }
  // forget a worktree whose directory was deleted, so its branch can be checked out again
  await git(options.repoDir, "worktree", "prune");
  const branchExists = await git(options.repoDir, "branch", "--list", branch);
  if (branchExists) {
    await git(options.repoDir, "worktree", "add", path, branch);
  } else {
    await git(
      options.repoDir,
      "worktree",
      "add",
      "-b",
      branch,
      path,
      "origin/HEAD",
    );
  }
  return path;
}

/** Commits everything in the worktree; false when there was nothing to commit. Never pushes. */
export async function commitAll(options: {
  cwd: string;
  agentId: string;
  runId: string;
}): Promise<boolean> {
  await git(options.cwd, "add", "--all");
  if (!(await git(options.cwd, "status", "--porcelain"))) return false;
  await git(
    options.cwd,
    "-c",
    "user.name=harness-agent",
    "-c",
    "user.email=agent@harness.local",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--no-verify",
    "-m",
    `agent ${options.agentId} run ${options.runId}`,
  );
  return true;
}
