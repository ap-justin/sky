import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test("a config failure exits non-zero naming the variable, not its value, before opening anything", async () => {
  vi.stubEnv("SKY_API_KEY", undefined);
  vi.stubEnv("DATA_DIR", "/data");
  vi.stubEnv("PORT", "secret-ish-port");
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

  await expect(import("./main.js")).rejects.toThrow("exit 1");

  expect(exit).toHaveBeenCalledWith(1);
  const message = stderr.mock.calls.flat().join(" ");
  expect(message).toContain("SKY_API_KEY is missing");
  expect(message).toContain("PORT");
  expect(message).not.toContain("secret-ish-port");
});
