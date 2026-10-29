import { expect, test } from "vitest";
import { matchesPolicy } from "./policy.js";

test.each([
  // pattern, tool, input, held
  ["Bash", "Bash", { command: "ls" }, true],
  ["Bash", "Read", { file_path: "a.ts" }, false],
  ["Bash", "BashOutput", {}, false],
  ["Bash(git push:*)", "Bash", { command: "git push origin main" }, true],
  ["Bash(git push:*)", "Bash", { command: "git push" }, true],
  ["Bash(git push:*)", "Bash", { command: "git status" }, false],
  ["Bash(git push:*)", "Bash", { command: "cd repo && git push" }, true],
  ["Bash(git push:*)", "Bash", { command: "make; git push -f" }, true],
  ["Bash(git push:*)", "Bash", { command: "echo 'git push'" }, false],
  ["Bash(npm test)", "Bash", { command: "npm test" }, true],
  ["Bash(npm test)", "Bash", { command: "npm test -- --watch" }, false],
  ["Bash(git push:*)", "Write", { file_path: "git push" }, false],
  ["Write(infra/:*)", "Write", { file_path: "infra/main.tf" }, true],
  ["Write(infra/:*)", "Write", { file_path: "src/infra/main.tf" }, false],
  ["Edit(.env)", "Edit", { file_path: ".env" }, true],
  [
    "NotebookEdit(nb/:*)",
    "NotebookEdit",
    { notebook_path: "nb/a.ipynb" },
    true,
  ],
  ["Bash(git push:*)", "Bash", {}, false],
] as const)("%s on %s %j → %s", (pattern, tool, input, held) => {
  expect(matchesPolicy([pattern], tool, input)).toBe(held);
});

test("an empty policy holds nothing", () => {
  expect(matchesPolicy([], "Bash", { command: "rm -rf /" })).toBe(false);
});

test("any one matching pattern holds the call", () => {
  expect(
    matchesPolicy(["Read", "Bash(git push:*)"], "Bash", {
      command: "git push",
    }),
  ).toBe(true);
});
