import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import { leaks, server } from "./msw.js";

test("a handled request is answered by its handler", async () => {
  server.use(
    http.get("https://api.test/ping", () => HttpResponse.json({ ok: true })),
  );
  const res = await fetch("https://api.test/ping");
  expect(await res.json()).toEqual({ ok: true });
});

test("a request with no handler rejects and is recorded as a leak", async () => {
  await expect(fetch("https://api.test/unhandled")).rejects.toThrow();
  expect(leaks.splice(0)).toEqual(["unhandled GET https://api.test/unhandled"]);
});
