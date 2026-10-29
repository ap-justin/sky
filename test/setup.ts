import { afterAll, afterEach, beforeAll, expect } from "vitest";
import { leaks, server } from "./msw.js";

// 'error' rejects the fetch, which app code may catch and render as a fallback; the afterEach guard fails the test regardless
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  server.resetHandlers();
  expect(leaks.splice(0), "requests no handler answered").toEqual([]);
});
afterAll(() => server.close());
