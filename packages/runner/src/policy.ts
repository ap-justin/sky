import { z } from "zod";

/** The input field a parenthesised pattern matches against, per tool. */
const ARGUMENT_FIELD: Record<string, string> = {
  Bash: "command",
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  NotebookEdit: "notebook_path",
};

const PATTERN = /^([A-Za-z0-9_-]+)(?:\((.+)\))?$/;

/**
 * One approval-policy entry, in Claude Code permission-rule syntax: `Tool`, `Tool(exact)`
 * or `Tool(prefix:*)`. The parenthesised form only exists for the tools in ARGUMENT_FIELD.
 */
export const PolicyPattern = z.string().refine((s) => {
  const [, tool = "", argument] = PATTERN.exec(s) ?? [];
  return tool !== "" && (argument === undefined || tool in ARGUMENT_FIELD);
}, "expected Tool, Tool(exact) or Tool(prefix:*) for Bash, Read, Write, Edit or NotebookEdit");

/** Whether `policy` holds this tool call for approval. Patterns are assumed valid `PolicyPattern`s. */
export function matchesPolicy(
  policy: readonly string[],
  toolName: string,
  input: unknown,
): boolean {
  return policy.some((pattern) => matchesOne(pattern, toolName, input));
}

function matchesOne(pattern: string, toolName: string, input: unknown) {
  const [, tool, rule] = PATTERN.exec(pattern) ?? [];
  if (tool !== toolName) return false;
  if (rule === undefined) return true;
  const value = (input as Record<string, unknown> | null)?.[
    ARGUMENT_FIELD[toolName] ?? ""
  ];
  if (typeof value !== "string") return false;
  const prefix = rule.endsWith(":*") ? rule.slice(0, -2) : undefined;
  // a compound command is held when any one of its commands matches, so `cd x && git push` can't slip past
  const candidates =
    toolName === "Bash" ? value.split(/&&|\|\||[;|&\n]/) : [value];
  return candidates.some((c) => {
    const candidate = c.trim();
    return prefix === undefined
      ? candidate === rule
      : candidate.startsWith(prefix);
  });
}
