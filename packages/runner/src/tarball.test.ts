import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { readTarball } from "./tarball.js";

const BLOCK = 512;

/** One tar header; checksum left blank, which `readTarball` doesn't read. */
function header(
  type: string,
  size: Buffer | number,
  fields: { name?: string; linkname?: string } = {},
) {
  const block = Buffer.alloc(BLOCK);
  block.write(fields.name ?? "f", 0, 100, "utf8");
  block.write(fields.linkname ?? "", 157, 100, "utf8");
  block.write(type, 156, 1, "latin1");
  if (typeof size === "number") {
    block.write(size.toString(8).padStart(11, "0"), 124, 11, "latin1");
  } else {
    size.copy(block, 124);
  }
  return block;
}

const padded = (body: Buffer) =>
  Buffer.concat([body, Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK)]);

function entry(
  type: string,
  body: Buffer | string = "",
  fields: { name?: string; linkname?: string; sizeField?: Buffer } = {},
) {
  const bytes = Buffer.from(body);
  return Buffer.concat([
    header(type, fields.sizeField ?? bytes.length, fields),
    padded(bytes),
  ]);
}

/** A pax record: `<length> <key>=<value>\n`, the length counting its own digits and the bytes. */
function record(key: string, value: string) {
  const rest = Buffer.from(` ${key}=${value}\n`);
  let length = rest.length + 1;
  while (String(length).length + rest.length !== length)
    length = String(length).length + rest.length;
  return Buffer.concat([Buffer.from(String(length)), rest]);
}

const END = Buffer.alloc(BLOCK * 2);
const tarball = (...entries: Buffer[]) =>
  gzipSync(Buffer.concat([...entries, END]));
const read = (...entries: Buffer[]) =>
  readTarball(tarball(...entries)).map((blob) => blob.toString("utf8"));

describe("files", () => {
  test("a regular file, one spelled with a NUL type, and a contiguous one (type 7) are all read", () => {
    expect(
      read(entry("0", "plain"), entry("\0", "nul-typed"), entry("7", "contig")),
    ).toEqual(["plain", "nul-typed", "contig"]);
  });

  test("a file whose size is not a multiple of 512 does not shift the entry after it", () => {
    const long = "x".repeat(BLOCK + 1);
    expect(read(entry("0", long), entry("0", "next"))).toEqual([long, "next"]);
  });

  test("an empty file is read as empty", () => {
    expect(read(entry("0", ""), entry("0", "after"))).toEqual(["", "after"]);
  });

  test("directories, hard links, the global pax header and a GNU long name are skipped, and the file after each is kept", () => {
    expect(
      read(
        entry("g", record("comment", "0123456789abcdef")),
        entry("5", "", { name: "dir/" }),
        entry("1", "", { linkname: "f" }),
        entry("L", `${"n".repeat(150)}\0`),
        entry("0", "kept"),
      ),
    ).toEqual(["kept"]);
  });

  test("nothing after the end-of-archive blocks is read", () => {
    const tar = gzipSync(
      Buffer.concat([entry("0", "in"), END, entry("0", "out")]),
    );
    expect(readTarball(tar).map(String)).toEqual(["in"]);
  });
});

describe("size", () => {
  test("a base-256 size field (high bit set) is read as a number", () => {
    const sizeField = Buffer.alloc(12);
    sizeField[0] = 0x80;
    sizeField.writeUInt32BE(600, 8);
    const body = "b".repeat(600);
    expect(read(entry("0", body, { sizeField }), entry("0", "next"))).toEqual([
      body,
      "next",
    ]);
  });

  test("a file cut off inside its body is a named error, not a short file", () => {
    const cut = gzipSync(
      Buffer.concat([header("0", 1000), Buffer.from("only ten b")]),
    );
    expect(() => readTarball(cut)).toThrow("the tarball ends mid-file");
  });

  test("bytes that are not gzip throw instead of reading as empty", () => {
    expect(() => readTarball(Buffer.from("not a tarball"))).toThrow();
  });
});

describe("symlinks", () => {
  test("a symlink's blob is its target, from the header when it fits in 100 bytes", () => {
    expect(read(entry("2", "", { linkname: "README.md" }))).toEqual([
      "README.md",
    ]);
  });

  test("a pax linkpath carries a target the header can't, in UTF-8 bytes rather than characters", () => {
    const target = `${"é".repeat(80)}/end`;
    expect(Buffer.byteLength(target)).toBeGreaterThan(100);
    expect(
      read(
        entry("x", record("linkpath", target)),
        entry("2", "", { linkname: "truncated-by-the-header" }),
      ),
    ).toEqual([target]);
  });

  test("a pax header applies to the next entry only", () => {
    expect(
      read(
        entry("x", record("linkpath", "from-pax")),
        entry("2", "", { linkname: "h1" }),
        entry("2", "", { linkname: "from-header" }),
      ),
    ).toEqual(["from-pax", "from-header"]);
  });

  test("pax records other than linkpath leave the header's target alone", () => {
    expect(
      read(
        entry("x", Buffer.concat([record("path", "p"), record("mtime", "1")])),
        entry("2", "", { linkname: "from-header" }),
      ),
    ).toEqual(["from-header"]);
  });

  test("a GNU long link (type K) carries the target, without its NUL, to the next entry only", () => {
    const target = "t".repeat(130);
    expect(
      read(
        entry("K", `${target}\0`),
        entry("2", "", { linkname: "cut-off" }),
        entry("2", "", { linkname: "own" }),
      ),
    ).toEqual([target, "own"]);
  });

  test("a pax linkpath wins over a GNU long link, which wins over the header", () => {
    expect(
      read(
        entry("K", "from-gnu\0"),
        entry("x", record("linkpath", "from-pax")),
        entry("2", "", { linkname: "from-header" }),
        entry("K", "from-gnu\0"),
        entry("2", "", { linkname: "from-header" }),
      ),
    ).toEqual(["from-pax", "from-gnu"]);
  });

  test("a pax record before a regular file is dropped with it, not carried to the symlink after", () => {
    expect(
      read(
        entry("x", record("linkpath", "stale")),
        entry("0", "file"),
        entry("2", "", { linkname: "own" }),
      ),
    ).toEqual(["file", "own"]);
  });
});
