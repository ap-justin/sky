import { expect, test } from "vitest";
import { name } from "./index.js";

test("exports its package name", () => {
  expect(name).toBe("@harness/api");
});
