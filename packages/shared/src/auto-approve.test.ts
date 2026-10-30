import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  type AskReason,
  type AutoApprove,
  autoApproveVerdict,
  isAutoApproved,
  parseCommandEntry,
} from "./auto-approve.js";

const CWD = "/workspace/worktrees/agt_1";
const DEFAULTS: AutoApprove = { defaults: true, commands: [] };
const approved = (command: string, config = DEFAULTS) =>
  isAutoApproved(command, config, CWD);
const verdict = (command: string, config = DEFAULTS) =>
  autoApproveVerdict(command, config, CWD);

test.each([
  "ls",
  "ls -la src",
  "ls -R packages/runner",
  "cat package.json",
  "cat src/a.ts src/b.ts",
  "grep -n foo src/a.ts",
  'grep -n "a|b" src/a.ts',
  "grep -n foo src",
  "rg foo",
  "rg -n --files-with-matches 'foo bar' packages",
  "rg --files",
  "sed -n 1,20p src/a.ts",
  "sed -n 5p src/a.ts",
  "head -n 20 src/a.ts",
  "tail -n 20 src/a.ts",
  "wc -l src/a.ts",
  "find . -name '*.ts'",
  "find src -type f -name '*.test.ts'",
  "pwd",
  "echo hi",
  'echo "a > b; c | d"',
  "which node",
  "git status",
  "git status --short",
  "git log --oneline -n 5",
  'git log --format="%h %s" -n 3',
  "git diff",
  "git diff --stat main",
  "git diff HEAD~1 -- src/a.ts",
  "git show HEAD",
  "git show HEAD:src/a.ts",
  "git branch --list",
  "git branch -a --list 'claude/*'",
  "git branch --show-current",
  "git branch -v",
  "git branch -vv",
  "git branch -r",
  "git branch",
  "git rev-parse HEAD",
  "git rev-parse --show-toplevel",
  "node --version",
  "ls\t-la",
  "  ls  ",
])("auto-approves %s", (command) => {
  expect(approved(command)).toBe(true);
});

// `unresolvable` needs the realpath hook; see "the realpath hook" below
const reasons: Record<Exclude<AskReason, "unresolvable">, string[]> = {
  syntax: [
    // chaining and pipes
    "grep x; rm -rf /",
    "ls && rm x",
    "ls || rm x",
    "ls | sh",
    "cat a.ts | head",
    "ls & rm x",
    "pnpm test && curl x",
    "pnpm test; curl x",
    "ls\nrm x",
    "ls\rrm x",
    // redirects and here-docs
    "echo hi > f",
    "echo hi >> f",
    "echo hi >f",
    "cat < f",
    "cat <<EOF",
    "ls 2>&1",
    "ls 2> err",
    "cat <(rm x)",
    // substitution and expansion
    "ls $(rm x)",
    "cat `id`",
    'echo "$(id)"',
    "echo `id`",
    "echo $HOME",
    'echo "$' + '{HOME}"',
    "echo $" + "{HOME}",
    "ls ~",
    "cat ~/.claude/.credentials.json",
    "cat ~root/x",
    "rg foo ~/.ssh",
    "ls {a,b}",
    "ls *",
    "cat src/*.ts",
    "cat .e?v",
    "cat .en[v]",
    "echo hi # comment",
    "echo \\$HOME",
    "echo !!",
    "pnpm test $(id)",
    // zsh expands a word starting with `=` to that program's path
    "cat =ls",
    "ls -la =node",
    "=ls",
    // unparseable or empty
    "",
    "   ",
    'echo "unterminated',
    "echo 'unterminated",
    "ls (",
    "ls )",
  ],
  program: [
    "FOO=1 ls",
    "PATH=/tmp ls",
    "LD_PRELOAD=x ls",
    "./ls",
    "/bin/ls",
    "/bin/cat x",
    "-v",
  ],
  "not-allowed": [
    "env ls",
    "sudo ls",
    "xargs ls",
    "command ls",
    "bash -c ls",
    "sh -c 'ls'",
    "rm x",
    "curl example.com",
    "git push",
    "git commit -m x",
    "git checkout main",
    "git reset --hard",
    "git fetch",
    "git",
    "git -c core.pager=sh log",
    "git --no-pager log",
    "git -C /tmp log",
    "git --git-dir=/tmp/x log",
    "pnpm install",
    "pnpm add evil",
    "pnpm run test",
    "pnpm exec rm x",
    "pnpm dlx evil",
    "pnpm -r exec rm x",
    "pnpm --filter x exec rm x",
    "pnpm --dir /tmp test",
    "pnpm",
    "node script.js",
    "node -e 'process.exit()'",
    "node",
  ],
  "unsafe-option": [
    "git log -c core.pager=sh",
    "git diff --output=f",
    "git diff --output f",
    "git log --output=f",
    "git diff --ext-diff",
    "git show --textconv HEAD:x",
    "git diff --no-index src/a.ts src/b.ts",
    "git log --open-files-in-pager",
    "git diff -Ovim",
    "git log --exec-path=x",
    "git log --work-tree=x",
    "git log --git-dir=x",
    "git branch newbranch",
    "git branch -d main",
    "git branch -D main",
    "git branch -m a b",
    "git branch -c a b",
    "git branch --set-upstream-to=origin/main",
    "git branch --delete main",
    "pnpm test --fix",
    "pnpm lint --write",
    "pnpm test -u",
    "pnpm --filter 'a;b' test",
    "pnpm --filter",
    "node --version --eval x",
    // write-capable flags on allowlisted programs
    "sed -i s/a/b/ f",
    "sed -i.bak s/a/b/ f",
    "sed -n -i 1p f",
    "sed -ni 1p f",
    "sed -n 1w out f",
    "sed -n 1e f",
    "sed -n '1p;w out' f",
    "sed s/a/b/ f",
    "sed -n 1p",
    "sed -n 1p -s f",
    "sed --in-place s/a/b/ f",
    "find . -delete",
    "find . -exec rm '{}' ';'",
    "find . -exec rm '{}' +",
    "find . -execdir rm '{}' ';'",
    "find . -ok rm '{}' ';'",
    "find . -okdir rm '{}' ';'",
    "find . -fprint out",
    "find . -fprint0 out",
    "find . -fprintf out x",
    "find . -fls out",
    // following links walks out of the root; a list file names paths no check sees
    "find -L .",
    "find . -follow",
    "find -files0-from list -name x",
    "wc --files0-from=list",
    "wc --files0-from list",
    "wc --files0 list",
    "tail -f log",
    "tail -F log",
    "tail --follow log",
    "grep -r foo .",
    "grep -rn foo src",
    "grep -R foo .",
    "grep --recursive foo .",
    "grep -d recurse foo .",
    "grep --directories=recurse foo .",
    "rg --pre ./x foo",
    "rg --pre=./x foo",
    "rg -z foo",
    "rg --search-zip foo",
    "rg -u foo",
    "rg -uu foo",
    "rg --unrestricted foo",
    "rg --hidden foo",
    "rg -. foo",
    "rg --no-ignore foo",
    "rg --no-ignore-vcs foo",
    "rg --ignore-file=x foo",
    "rg -L foo",
    "rg --follow foo",
    "rg --hostname-bin x foo",
  ],
  "outside-root": [
    "cat /home/sprite/.claude/.credentials.json",
    'cat "~/.ssh/id_rsa"',
    "cat ../x",
    "cat src/../../x",
    "cat /etc/passwd",
    "cat /proc/self/environ",
    "cat /proc/1/environ",
    "ls /",
    "ls ..",
    "ls /home/sprite/.config",
    "cat --file=/etc/passwd",
    "wc -l /etc/passwd",
    "tail -n 5 ../secret",
    "find / -name x",
    "find .. -name x",
    "rg foo /etc",
    "grep foo ../x",
    "sed -n 1p /etc/passwd",
    `cat ${CWD}/../other/x`,
    "git diff -- ../x",
    "git show HEAD:../x",
    "git log --format=%h:/etc/passwd",
  ],
  "sensitive-path": [
    "cat .env",
    "cat .env.local",
    "cat packages/api/.env",
    "cat .envrc",
    "head .env.production",
    "cat .claude/.credentials.json",
    "cat .config/gh/hosts.yml",
    "ls .ssh",
    "cat .ssh/id_rsa",
    "cat id_ed25519",
    "cat credentials.json",
    "cat aws-credentials",
    "cat token.txt",
    "cat tokens/a",
    "cat github_token",
    "cat secret.yaml",
    "cat secrets/prod.json",
    "cat server.pem",
    "cat server.key",
    "cat .npmrc",
    "cat .netrc",
    "cat .aws/config",
    "cat .git/config",
    "find . -name '.env*'",
    "sed -n 1p .env",
    "git show HEAD:.env",
    "git show HEAD:.git/config",
    "ls .gnupg",
    "cat .kube/config",
    "cat .docker/config.json",
    "cat .pgpass",
    "cat environ",
    "cat id_rsa",
    "cat id_dsa",
    "cat id_ecdsa",
    "cat .dev.vars",
    "cat .yarnrc.yml",
    "cat .pypirc",
    "cat cert.p12",
    "cat cert.pfx",
    "cat .htpasswd",
    "cat terraform.tfstate",
    "cat infra/prod.tfstate.backup",
  ],
};

describe.each(Object.entries(reasons))("asks (%s)", (reason, commands) => {
  test.each(commands)("%j", (command) => {
    expect(verdict(command)).toBe(reason);
    expect(approved(command)).toBe(false);
  });
});

test("grep takes only the long options it lists, so an abbreviation can't recurse", () => {
  for (const command of [
    "grep --line-number foo src/a.ts",
    "grep --ignore-case --count foo src/a.ts",
    "grep --context=2 --fixed-strings foo src/a.ts",
    "grep --regexp foo src/a.ts",
  ])
    expect(verdict(command), command).toBe("approved");
  // GNU getopt takes any unambiguous prefix: `--rec` is `--recursive`
  for (const command of [
    "grep --rec --null KEY .",
    "grep --deref KEY .",
    "grep --dir=rec KEY .",
    "grep --dir=recurse KEY .",
    "grep --line-num foo src/a.ts",
    "grep --include=x foo src/a.ts",
  ])
    expect(verdict(command), command).toBe("unsafe-option");
});

test("rg refuses globs and types, which override its hidden-file and gitignore filters", () => {
  for (const command of [
    "rg -g '.e*' ''",
    "rg -g '.*' KEY",
    "rg --glob='.?nv' ''",
    "rg --glob '.?nv' ''",
    "rg --iglob '.E*' ''",
    "rg -ng '.e*' ''",
    "rg --type-add 'e:.env' -te ''",
    "rg --trace -f patterns a.txt",
    "rg --debug foo",
  ])
    expect(verdict(command), command).toBe("unsafe-option");
  expect(verdict("rg -n -t ts foo src")).toBe("approved");
});

test("a path glued to a short option is checked like a separate one", () => {
  expect(verdict("rg --trace -f/etc/passwd a.txt")).toBe("unsafe-option");
  expect(verdict("rg -f/etc/passwd a.txt")).toBe("outside-root");
  expect(verdict("grep -f/etc/passwd a.txt")).toBe("outside-root");
  expect(verdict("grep -of/proc/1/cmdline a.txt")).toBe("outside-root");
  expect(verdict("grep -f.env -o x a.txt")).toBe("sensitive-path");
  expect(verdict("head -c1 src/a.ts")).toBe("approved");
});

test("tail can't follow through a bundle, a glued count or an abbreviation", () => {
  for (const command of [
    "tail -fn1 src/a.ts",
    "tail -f1 src/a.ts",
    "tail -n1f src/a.ts",
    "tail -5f src/a.ts",
    "tail --fol src/a.ts",
    "tail --f src/a.ts",
    "tail --follow=name src/a.ts",
  ])
    expect(verdict(command), command).toBe("unsafe-option");
  expect(verdict("tail -n1 src/a.ts")).toBe("approved");
  expect(verdict("tail -c 100 src/a.ts")).toBe("approved");
});

test("dot segments are collapsed before the secret-path check", () => {
  expect(verdict("cat .git/./config")).toBe("sensitive-path");
  expect(verdict("cat src/../.git/config")).toBe("sensitive-path");
  expect(verdict("cat .git//config")).toBe("sensitive-path");
  expect(verdict("cat .git/hooks/../config")).toBe("sensitive-path");
  expect(verdict("cat .git/HEAD")).toBe("approved");
});

describe("a shell cwd apart from the root", () => {
  const at = (cwd: string) => (command: string) =>
    autoApproveVerdict(command, DEFAULTS, { root: CWD, cwd });

  test("resolves relative paths against cwd and contains them in root", () => {
    const inSrc = at(`${CWD}/src`);
    expect(inSrc("cat a.ts")).toBe("approved");
    expect(inSrc("cat ../package.json")).toBe("approved");
    expect(inSrc("cat ../.env")).toBe("sensitive-path");
    expect(inSrc("cat ../../x")).toBe("outside-root");
    expect(
      isAutoApproved("cat ../package.json", DEFAULTS, {
        root: CWD,
        cwd: `${CWD}/src`,
      }),
    ).toBe(true);
  });

  test("a cwd outside the root, or at a secret, asks even with no path argument", () => {
    expect(at("/home/sprite")("ls")).toBe("outside-root");
    expect(at(`${CWD}/..`)("git status")).toBe("outside-root");
    expect(at(`${CWD}/.ssh`)("ls")).toBe("sensitive-path");
  });
});

describe("the realpath hook", () => {
  const base = realpathSync.native(
    mkdtempSync(join(tmpdir(), "auto-approve-")),
  );
  const root = join(base, "wt");
  const outside = join(base, "outside");
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, ".git"));
  mkdirSync(join(outside, "dir"), { recursive: true });
  writeFileSync(join(root, "a.txt"), "a");
  writeFileSync(join(root, ".git", "config"), "");
  writeFileSync(join(outside, "plain.txt"), "x");
  symlinkSync(join(outside, "plain.txt"), join(root, "docs", "notes"));
  symlinkSync("../.git/config", join(root, "docs", "cfg"));
  symlinkSync(join(outside, "dir"), join(root, "l"));
  symlinkSync("loop", join(root, "loop"));
  symlinkSync(root, join(base, "wt-link"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const real = (command: string, where: { root?: string; cwd?: string } = {}) =>
    autoApproveVerdict(command, DEFAULTS, {
      root,
      ...where,
      realpath: realpathSync.native,
    });

  test("approves an ordinary file and a path that doesn't exist yet", () => {
    expect(real("cat a.txt")).toBe("approved");
    expect(real("cat docs/missing.md")).toBe("approved");
    expect(real("grep -n foo a.txt")).toBe("approved");
  });

  test("asks when a symlink leaves the root or lands on a secret", () => {
    expect(real("cat docs/notes")).toBe("outside-root");
    expect(real("cat docs/cfg")).toBe("sensitive-path");
    // the kernel takes `..` after the link's target, not lexically
    expect(real("cat l/../plain.txt")).toBe("outside-root");
    expect(real("ls", { cwd: join(root, "l") })).toBe("outside-root");
  });

  test("a root reached through a symlink still contains its files", () => {
    expect(real("cat a.txt", { root: join(base, "wt-link") })).toBe("approved");
  });

  test("asks when resolving fails for any reason but a missing path", () => {
    expect(real("cat loop")).toBe("unresolvable");
    const denied = () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    expect(
      autoApproveVerdict("cat a.txt", DEFAULTS, { root, realpath: denied }),
    ).toBe("unresolvable");
  });
});

test("every argument is path-checked, so a pattern or name holding token, secret or credentials asks", () => {
  // deliberate fail-closed: the parser can't tell a search pattern from a path, and these
  // three match anywhere in a segment, not only as a whole file name
  for (const command of [
    "rg token src",
    "grep secret src/a.ts",
    "grep -n getCredentials src/a.ts",
    "cat src/tokenizer.ts",
    "ls secrets-doc",
    "git log --grep=token",
  ])
    expect(verdict(command), command).toBe("sensitive-path");
  expect(verdict("rg tok src")).toBe("approved");
});

test("an absolute path inside the worktree is fine", () => {
  expect(approved(`cat ${CWD}/src/a.ts`)).toBe(true);
  expect(approved(`ls ${CWD}`)).toBe(true);
});

test("quoting can't smuggle a program or secret past the checks", () => {
  expect(approved('"ls"')).toBe(true);
  expect(approved("l's'")).toBe(true);
  expect(approved('"rm" x')).toBe(false);
  expect(approved('cat ".env"')).toBe(false);
  expect(approved("cat '.e'nv")).toBe(false);
  expect(approved('cat "~/.ssh/id_rsa"')).toBe(false);
  expect(approved('"FOO=1" ls')).toBe(false);
  expect(approved("FOO='1' ls")).toBe(false);
  expect(approved('echo ";" && rm x')).toBe(false);
});

test("echo prints and never reads, so a path-like argument is fine", () => {
  expect(approved("echo /etc/passwd")).toBe(true);
  expect(approved("echo .env")).toBe(true);
});

describe("pnpm test, typecheck and lint are in the defaults", () => {
  const scripts = DEFAULTS;

  test.each(["pnpm run test", "pnpm install", "pnpm exec rm x"])(
    "%s still asks",
    (command) => expect(verdict(command)).toBe("not-allowed"),
  );

  test.each([
    "pnpm test",
    "pnpm typecheck",
    "pnpm lint",
    "pnpm test packages/runner/src/policy.test.ts",
    "pnpm test -- --run",
    "pnpm test --run",
    "pnpm test --silent",
    "pnpm -r test --bail",
    "pnpm test --passWithNoTests",
    "pnpm -r test",
    "pnpm -r --filter @sky/runner test",
    "pnpm --filter @sky/runner typecheck",
    "pnpm --filter=@sky/runner lint",
    "pnpm -F ./packages/runner test",
  ])("%s is approved", (command) => {
    expect(verdict(command, scripts)).toBe("approved");
  });

  test.each([
    ["pnpm --filter --workspace-root test", "unsafe-option"],
    ["pnpm -F -w test", "unsafe-option"],
    // not stripped as a filter, so `--filter=-w` is taken for the script name
    ["pnpm --filter=-w test", "not-allowed"],
  ])("%s asks: a filter value that is a flag", (command, reason) => {
    expect(verdict(command, scripts)).toBe(reason);
  });
});

test("a command outside the defaults asks", () => {
  expect(approved("make check")).toBe(false);
  expect(approved("git tag --list")).toBe(false);
});

test("added commands join the defaults", () => {
  const config = { defaults: true, commands: ["git tag --list", "make check"] };
  expect(approved("git tag --list", config)).toBe(true);
  expect(approved("git tag --list 'v*'", config)).toBe(true);
  expect(approved("make check", config)).toBe(true);
  expect(approved("make deploy", config)).toBe(false);
  expect(approved("git tag -d v1", config)).toBe(false);
  expect(approved("git status", config)).toBe(true);
});

test("replacing the defaults drops them", () => {
  const config = { defaults: false, commands: ["make check"] };
  expect(approved("make check", config)).toBe(true);
  expect(approved("ls", config)).toBe(false);
  expect(approved("git status", config)).toBe(false);
});

test("an empty replacement turns auto-approval off", () => {
  const off = { defaults: false, commands: [] };
  for (const command of ["ls", "git status", "pnpm test", "echo hi"])
    expect(approved(command, off)).toBe(false);
});

test("added commands get the same structural and path checks", () => {
  const config = { defaults: true, commands: ["make check", "find", "git"] };
  expect(approved("make check; rm x", config)).toBe(false);
  expect(approved("make check > f", config)).toBe(false);
  expect(approved("make check ../x", config)).toBe(false);
  expect(approved("make check .env", config)).toBe(false);
  expect(approved("FOO=1 make check", config)).toBe(false);
  // a broad entry doesn't lift the per-program guards
  expect(approved("find . -delete", config)).toBe(false);
  expect(approved("git diff --output=f", config)).toBe(false);
  expect(approved("git -c core.pager=sh log", config)).toBe(false);
});

test("an entry is plain leading words", () => {
  expect(parseCommandEntry("git tag --list")).toEqual(["git", "tag", "--list"]);
  expect(parseCommandEntry("  make   check ")).toEqual(["make", "check"]);
  for (const bad of [
    "",
    "  ",
    "ls; rm x",
    "ls | sh",
    "ls > f",
    "$(id)",
    "A=1 ls",
  ])
    expect(parseCommandEntry(bad)).toBeUndefined();
});
