import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { runCli } from "./testing.js";
import { version } from "./version.js";

test("version matches package.json", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  expect(version).toBe(pkg.version);
});

test.each(["--version", "-v"])(
  "%s prints the version and exits 0",
  async (flag) => {
    const out = await runCli([flag]);
    expect(out).toMatchObject({ code: 0, stdout: `${version}\n`, stderr: "" });
  },
);
