import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "{apps,packages}/*/src/**/*.test.ts",
      "db/src/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    setupFiles: ["test/setup.ts"],
  },
});
