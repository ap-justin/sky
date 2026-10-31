import { gunzipSync, gzipSync } from "node:zlib";
import { HttpResponse } from "msw";
import { vi } from "vitest";

const gz = (body: Buffer | string) =>
  new HttpResponse(body, { headers: { "content-type": "application/x-gzip" } });

/** A body that delivers `head`, then never ends: only the request's timeout gets the reader out. */
const stalled = (head: Buffer) =>
  new HttpResponse(
    new ReadableStream({
      start: (controller) => controller.enqueue(head),
    }),
    // a declared length it never reaches; without one, the socket closing after the abort trips an undici assertion
    { headers: { "content-length": String(head.length + 1) } },
  );

export type TarballFault = {
  name: string;
  /** What the pull's fallback log line carries as the cause. */
  cause: RegExp;
  /** Run before the pull. */
  setup?: () => void;
  /** What codeload answers, given the real archive of the commit. */
  answer: (archive: Buffer) => Response;
};

/**
 * The ways a tarball can fail on codeload's leg, each as the answer that makes it so. `inside` is
 * text from a file in the archive; the "ends mid-file" fault cuts the tar there.
 */
export function tarballFaults(inside: string): TarballFault[] {
  return [
    {
      name: "not a gzip stream",
      cause: /incorrect header check/,
      answer: () => gz("this is not a tarball"),
    },
    {
      name: "gzip cut short",
      cause: /unexpected end of file/,
      answer: (archive) => gz(archive.subarray(0, archive.length / 2)),
    },
    {
      name: "tar ends mid-file",
      cause: /the tarball ends mid-file/,
      answer: (archive) => {
        const tar = gunzipSync(archive);
        return gz(gzipSync(tar.subarray(0, tar.indexOf(inside) + 3)));
      },
    },
    {
      name: "reset mid-body",
      // msw closes the socket on a stream error, which fetch reports before the body is read
      cause: /failed: fetch failed/,
      answer: (archive) =>
        new HttpResponse(
          new ReadableStream({
            start(controller) {
              controller.enqueue(archive.subarray(0, 64));
              controller.error(new Error("socket hang up"));
            },
          }),
        ),
    },
    {
      name: "timeout mid-body",
      cause: /failed reading its body/,
      setup() {
        const real = AbortSignal.timeout.bind(AbortSignal);
        // the request's 120 s timeout, shortened; undone by vi.restoreAllMocks
        vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(100));
      },
      answer: (archive) => stalled(archive.subarray(0, 64)),
    },
    {
      name: "codeload answers 500",
      cause: /returned 500: codeload down/,
      answer: () =>
        HttpResponse.json({ message: "codeload down" }, { status: 500 }),
    },
    {
      name: "codeload connection fails",
      cause: /failed: /,
      answer: () => HttpResponse.error(),
    },
  ];
}
