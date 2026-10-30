// proves each lint/*.grit rule still matches: the plugin diagnostics biome
// reports on lint/fixtures must be exactly the lines marked `expect-plugin`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const dir = new URL(".", import.meta.url).pathname;
const file = `${dir}fixtures/violations.ts`;

let out;
try {
  out = execFileSync(
    "pnpm",
    [
      "exec",
      "biome",
      "lint",
      "--config-path",
      `${dir}fixtures.biome.json`,
      "--reporter=json",
      file,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
} catch (err) {
  // biome exits nonzero when diagnostics are found; the report is still on stdout
  out = err.stdout;
  if (!out) throw err;
}

const source = readFileSync(file, "utf8");
const flagged = new Set(
  JSON.parse(out)
    .diagnostics.filter((d) => d.category === "plugin")
    .map((d) => d.location.start.line),
);
const expected = new Set(
  source
    .split("\n")
    .flatMap((l, i) => (l.includes("// expect-plugin") ? [i + 1] : [])),
);

const missed = [...expected].filter((l) => !flagged.has(l));
const extra = [...flagged].filter((l) => !expected.has(l));
if (missed.length || extra.length) {
  console.error(
    `lint fixtures: rule missed line(s) [${missed}], unexpected hit(s) [${extra}]`,
  );
  process.exit(1);
}
console.log(
  `lint fixtures: ${expected.size} expected plugin hits, all matched`,
);
