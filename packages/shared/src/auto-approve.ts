import { posix } from "node:path";

/**
 * Bash commands that run without an approval request. Deliberately strict and fail-closed:
 * only a single simple command is ever approved, and anything this parser doesn't fully
 * understand is left for a person to decide.
 */

/**
 * Commands approved by default; each entry is the leading words of a command. The pnpm scripts
 * run whatever `package.json` says: they are here so a fix-and-verify loop doesn't ask, and an
 * environment that doesn't accept that drops them with `defaults: false`.
 */
export const DEFAULT_AUTO_APPROVE_COMMANDS: readonly string[] = [
  "ls",
  "cat",
  "grep",
  "rg",
  "sed",
  "head",
  "tail",
  "wc",
  "find",
  "pwd",
  "echo",
  "which",
  "git status",
  "git log",
  "git diff",
  "git show",
  "git branch",
  "git rev-parse",
  "pnpm test",
  "pnpm typecheck",
  "pnpm lint",
  "node --version",
];

export type AutoApprove = {
  /** Whether `DEFAULT_AUTO_APPROVE_COMMANDS` apply; false replaces them with `commands` alone. */
  defaults: boolean;
  /** Extra commands, each the leading words of a command, e.g. `git tag --list` or `make check`. */
  commands: string[];
};

type Word = { text: string; quoted: boolean };

// Outside quotes these either chain, redirect, substitute, expand or comment; inside quotes they are literal.
const UNQUOTED_SPECIAL = /[;&|<>()*?[\]{}#]/;
// Expand or escape even inside double quotes, so they are refused wherever they appear.
const ALWAYS_REFUSED = /[$`\\!\n\r\0]/;

/** Splits one simple command into words, or undefined when it holds anything but plain words. */
function tokenize(command: string): Word[] | undefined {
  if (ALWAYS_REFUSED.test(command)) return undefined;
  const words: Word[] = [];
  let text = "";
  let quoted = false;
  let open = false;
  let quote: string | undefined;
  for (const ch of command) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else text += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      quoted = true;
      open = true;
    } else if (ch === " " || ch === "\t") {
      if (open) words.push({ text, quoted });
      text = "";
      quoted = false;
      open = false;
    } else if (UNQUOTED_SPECIAL.test(ch)) {
      return undefined;
    } else {
      // a leading unquoted `~` is tilde expansion, and in zsh a leading `=` expands to a program's path
      if (!open && (ch === "~" || ch === "=")) return undefined;
      text += ch;
      open = true;
    }
  }
  if (quote !== undefined) return undefined;
  if (open) words.push({ text, quoted });
  return words;
}

/** The words of an allowlist entry, or undefined when it isn't a plain run of words. */
export function parseCommandEntry(entry: string): string[] | undefined {
  const words = tokenize(entry)?.map((w) => w.text);
  return words && words.length > 0 && !isAssignment(words[0] ?? "")
    ? words
    : undefined;
}

const isAssignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

const SENSITIVE_DIRS = new Set([
  ".claude",
  ".config",
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  "environ",
]);
const SENSITIVE_FILES =
  /^(\.env|\.dev\.vars|\.npmrc|\.yarnrc|\.netrc|\.pgpass|\.pypirc|\.htpasswd|id_(rsa|dsa|ecdsa|ed25519))|credentials|token|secret|\.tfstate|\.(pem|key|p12|pfx)$/i;

/** Every reading of `word` that a program might open as a path. */
function pathCandidates(word: string): string[] {
  const candidates = [word];
  // `--opt=value` and `rev:path` carry a path on either side of the separator
  for (const m of word.matchAll(/[=:]/g)) {
    candidates.push(word.slice(0, m.index), word.slice(m.index + 1));
  }
  // a short option's value may be glued on after any letter of a bundle (`-of/etc/passwd`)
  if (/^-[^-]/.test(word))
    for (let i = 2; i < word.length; i++) candidates.push(word.slice(i));
  return candidates;
}

const isOutside = (relative: string) =>
  relative === ".." || relative.startsWith("../");

/** Whether this path-ish text, resolved against `cwd`, points outside `root`. */
function leavesRoot(text: string, root: string, cwd: string): boolean {
  return (
    text.startsWith("~") ||
    isOutside(posix.relative(root, posix.resolve(cwd, text)))
  );
}

/** Whether this path-ish text names somewhere secrets live. */
function namesSecret(text: string): boolean {
  const segments = text.split(/[/=:]/).filter(Boolean);
  return (
    segments.some((s) => SENSITIVE_DIRS.has(s) || SENSITIVE_FILES.test(s)) ||
    segments.some((s, i) => s === ".git" && segments[i + 1] === "config")
  );
}

// `-L`/`-follow` walk through links the realpath check never sees; `-files0-from` reads its
// start paths from a file
const FIND_UNSAFE = new Set([
  "-L",
  "-follow",
  "-files0-from",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

// globs and type definitions override the hidden-file and gitignore filters; `--trace` and
// `--debug` print the patterns `-f` read. A short bundle holding any of `zuLg.` asks, even
// inside a glued value (`-ng.e*`), since the parser can't tell flag letters from value.
const RG_UNSAFE =
  /^(--(pre(-glob)?|hostname-bin|search-zip|unrestricted|hidden|follow|no-ignore.*|ignore-file|glob|iglob|type-add|trace|debug)(=.*)?|-(?!-)\S*[zuLg.]\S*)$/;

// GNU grep expands any unambiguous prefix (`--rec` is `--recursive`), so long options are
// matched exactly against this list and everything else asks; none of these recurses
const GREP_LONG =
  /^--(extended-regexp|fixed-strings|basic-regexp|perl-regexp|ignore-case|no-ignore-case|word-regexp|line-regexp|invert-match|count|files-with-matches|files-without-match|only-matching|quiet|silent|no-messages|byte-offset|line-number|with-filename|no-filename|initial-tab|null|text|no-group-separator|colou?r|regexp|file|max-count|before-context|after-context|context|binary-files|group-separator|label)(=.*)?$/;

const GIT_UNSAFE =
  /^(--output.*|--ext-diff|--textconv|--no-index|--open-files-in-pager.*|--exec-path.*|-c|-O.*|--work-tree.*|--git-dir.*)$/;

const GIT_BRANCH_FLAGS = new Set([
  "--list",
  "-l",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
  "--show-current",
  "--no-color",
  "--color",
]);

const PNPM_SCRIPT_FLAGS = new Set([
  "--run",
  "--silent",
  "--bail",
  "--passWithNoTests",
]);

// a package name or path; never a leading `-`, which pnpm would read as its own option
const FILTER_VALUE = /^[@A-Za-z0-9_./^][@A-Za-z0-9_./^-]*$/;

/** The canonical words (workspace options stripped) of a `pnpm` command, or undefined when its options aren't plain. */
function pnpmWords(words: string[]): string[] | undefined {
  const rest = words.slice(1);
  let i = 0;
  while (i < rest.length) {
    const w = rest[i] ?? "";
    if (w === "-r" || w === "--recursive") i += 1;
    else if (w === "--filter" || w === "-F") {
      if (!FILTER_VALUE.test(rest[i + 1] ?? "")) return undefined;
      i += 2;
    } else if (
      w.startsWith("--filter=") &&
      FILTER_VALUE.test(w.slice("--filter=".length))
    )
      i += 1;
    else break;
  }
  const [script, ...args] = rest.slice(i);
  if (script === undefined) return ["pnpm"];
  // only plain arguments and a few inert flags reach the script; `--fix`, `-u` and friends would write
  const safe = args.every(
    (a) => a === "--" || !a.startsWith("-") || PNPM_SCRIPT_FLAGS.has(a),
  );
  return safe ? ["pnpm", script, ...args] : undefined;
}

/**
 * Per-program checks that run whichever entry allowed the command; false means ask. With
 * `complete` false, `words` is only the start of a command and fails only if no command
 * starting with them could pass.
 */
function guard(words: string[], complete = true): boolean {
  const [program = "", ...args] = words;
  switch (program) {
    case "find":
      return !args.some((a) => FIND_UNSAFE.has(a));
    case "wc":
      // `--files0-from` reads the paths to count from a file; getopt takes any prefix down to `--f`
      return !args.some((a) => a.startsWith("--f"));
    case "grep":
      // recursing reads dotfiles such as `.env` without naming them
      return !args.some(
        (a) =>
          /^-[A-Za-z0-9]*[rRd]/.test(a) ||
          (a.startsWith("--") && a !== "--" && !GREP_LONG.test(a)),
      );
    case "rg":
      return !args.some((a) => RG_UNSAFE.test(a));
    case "sed": {
      // `sed -n 'N,Mp' file` only: `-i`, `w`, `e` and other scripts write or run things
      const [flag, script, ...files] = args;
      if (complete && files.length === 0) return false;
      return (
        (flag === undefined || flag === "-n") &&
        (script === undefined || /^\d+(,\d+)?p$/.test(script)) &&
        files.every((a) => !a.startsWith("-") || a === "--")
      );
    }
    case "tail":
      // follows forever: `f`/`F` anywhere in a bundle (`-fn1`, obsolete `-5f`/`+5f`), and
      // `--f…`, since getopt expands every prefix of `--follow`
      return !args.some((a) => /^([-+](?!-)\S*[fF]|--f)/.test(a));
    case "node":
      return (
        (complete ? args.length === 1 : args.length <= 1) &&
        (args[0] === undefined || args[0] === "--version" || args[0] === "-v")
      );
    case "git": {
      if (args.some((a) => GIT_UNSAFE.test(a))) return false;
      if (args[0] === "branch") {
        const rest = args.slice(1);
        const listing = rest.some((a) => a === "--list" || a === "-l");
        const unknownFlag = rest.some(
          (a) => a.startsWith("-") && !GIT_BRANCH_FLAGS.has(a),
        );
        const positional = rest.some((a) => !a.startsWith("-"));
        // `git branch name` creates one; a pattern is only a pattern next to `--list`
        return !unknownFlag && (!positional || listing || !complete);
      }
      return true;
    }
    default:
      return true;
  }
}

/**
 * Why an allowlist entry could never match a command, or undefined when one could. Whichever
 * entry allows a command, pnpm canonicalisation and the per-program checks still run, so an
 * entry they refuse is dead text.
 */
export function commandEntryProblem(entry: string): string | undefined {
  const words = parseCommandEntry(entry);
  if (!words)
    return "expected plain words: no operators, redirects, substitution or variable assignment";
  const [first = ""] = words;
  if (first.includes("/"))
    return `start with a program name, not a path: \`${first}\` never matches`;
  if (first.startsWith("-"))
    return `start with a program name, not an option: \`${first}\` never matches`;
  if (/\s/.test(first))
    return `\`${first}\` is one quoted word, never a program name; write the words unquoted`;
  if (first === "pnpm") {
    const canonical = pnpmWords(words);
    if (canonical?.length !== words.length)
      return "pnpm workspace options (-r, --filter) are dropped before matching, so leave them out, and script flags other than --run, --silent, --bail and --passWithNoTests always ask";
  }
  for (let end = 2; end <= words.length; end++)
    if (!guard(words.slice(0, end), false))
      return `\`${words[end - 1]}\` is refused for ${first} by the built-in checks, so this entry never matches`;
  return undefined;
}

/** Why a command still asks; see `autoApproveVerdict`. */
export type AskReason =
  /** not one simple command of plain words: chaining, redirection, substitution, expansion, bad quoting */
  | "syntax"
  /** starts with a variable assignment, a path or an option instead of a program name */
  | "program"
  /** no allowlist entry is a prefix of it */
  | "not-allowed"
  /** a per-program guard refuses an option or argument that writes, runs code, recurses or follows */
  | "unsafe-option"
  /** an argument, or the working directory, lies outside the root */
  | "outside-root"
  /** an argument, or the working directory, names somewhere secrets live */
  | "sensitive-path"
  /** the realpath hook threw for a reason other than a missing path, or the root doesn't resolve */
  | "unresolvable";

/** Where a command runs; a bare string is a root that is also the shell's cwd. */
export type AutoApproveScope = {
  /** The directory no path may leave: the agent's worktree. */
  root: string;
  /** The shell's working directory, which relative paths resolve against; `root` when omitted. */
  cwd?: string;
  /**
   * Resolves every symlink in an absolute path, so a link can't carry a path out of `root` or
   * onto a secret; `fs.realpathSync.native` fits. A path that doesn't exist (an error with code
   * `ENOENT` or `ENOTDIR`) is judged on its text alone; any other throw asks.
   */
  realpath?: (path: string) => string;
};

/**
 * `"approved"` when `command` may run without an approval request, else the first rule that
 * refuses it. `isAutoApproved` is this, reduced to a boolean.
 */
export function autoApproveVerdict(
  command: string,
  autoApprove: AutoApprove,
  scope: string | AutoApproveScope,
): "approved" | AskReason {
  const tokens = tokenize(command);
  if (!tokens || tokens.length === 0) return "syntax";
  const raw = tokens.map((t) => t.text);
  const first = raw[0] ?? "";
  if (isAssignment(first) || first.includes("/") || first.startsWith("-"))
    return "program";
  const words = first === "pnpm" ? pnpmWords(raw) : raw;
  if (!words) return "unsafe-option";

  const entries = [
    ...(autoApprove.defaults ? DEFAULT_AUTO_APPROVE_COMMANDS : []),
    ...autoApprove.commands,
  ];
  const allowed = entries.some((entry) => {
    const prefix = parseCommandEntry(entry);
    return prefix?.every((w, i) => words[i] === w);
  });
  if (!allowed) return "not-allowed";
  if (!guard(words)) return "unsafe-option";

  // echo only prints its arguments, so a path-like one isn't a read
  if (first === "echo") return "approved";
  const {
    root,
    cwd = root,
    realpath,
  } = typeof scope === "string" ? { root: scope } : scope;
  const args = raw.slice(1).flatMap(pathCandidates);
  // "." stands for the cwd itself, which `ls` or `git status` reads with no argument
  const targets = [".", ...args];
  if (targets.some((t) => leavesRoot(t, root, cwd))) return "outside-root";
  // `.git/./config` is `.git/config`, so the collapsed form is checked too
  const collapsed = targets.map((t) =>
    posix.relative(root, posix.resolve(cwd, t)),
  );
  if ([...args, ...collapsed].some(namesSecret)) return "sensitive-path";
  return realpath ? resolvedVerdict(targets, root, cwd, realpath) : "approved";
}

/** The same root and secret checks, on where each target's symlinks really lead. */
function resolvedVerdict(
  targets: string[],
  root: string,
  cwd: string,
  realpath: (path: string) => string,
): "approved" | AskReason {
  const resolve = (path: string): string | undefined => {
    try {
      return realpath(path);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw error;
    }
  };
  try {
    const realRoot = resolve(root);
    if (realRoot === undefined) return "unresolvable";
    for (const target of targets) {
      // joined, not normalized: the kernel applies `..` after following a link, not before
      const real = resolve(
        target.startsWith("/") ? target : `${cwd}/${target}`,
      );
      if (real === undefined) continue;
      const rel = posix.relative(realRoot, real);
      if (isOutside(rel)) return "outside-root";
      if (namesSecret(rel)) return "sensitive-path";
    }
    return "approved";
  } catch {
    return "unresolvable";
  }
}

/**
 * Whether `command` may run without an approval request: one simple command, none of the
 * shell's chaining, redirection, substitution or expansion, starting with an allowlisted
 * command, and touching no secret path nor anything outside the root. A string `scope` is
 * both root and cwd.
 */
export function isAutoApproved(
  command: string,
  autoApprove: AutoApprove,
  scope: string | AutoApproveScope,
): boolean {
  return autoApproveVerdict(command, autoApprove, scope) === "approved";
}
