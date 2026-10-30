import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "{apps,packages}/*/src/**/*.test.ts",
      "db/src/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    setupFiles: ["test/setup.ts"],
    // 8 GB laptop: default forks cores-1 workers; CI runners keep the default
    maxWorkers: process.env.CI ? undefined : 2,
  },
});
