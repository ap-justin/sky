import { gunzipSync } from "node:zlib";

/** What git stores as the entry's blob: a file's bytes, or a symlink's target. */
export type TarBlob = Buffer;

const BLOCK = 512;

const text = (block: Buffer, from: number, length: number) => {
  const field = block.subarray(from, from + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString("utf8");
};

const octal = (block: Buffer, from: number, length: number) => {
  const field = block.subarray(from, from + length);
  // base-256, which `git archive` never writes: past 8 GiB it puts 0 here and the size in a pax
  // `size` record, which this ignores; unreachable under GitHub's 100 MB file cap
  if (field[0] !== undefined && field[0] & 0x80) {
    let value = field[0] & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  return Number.parseInt(text(block, from, length).trim() || "0", 8);
};

/** The `key=value` records of a pax extended header: `<length> <key>=<value>\n`. */
function paxRecords(body: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    const length = Number.parseInt(body.subarray(at, space).toString(), 10);
    if (space === -1 || !(length > 0)) break;
    const record = body.subarray(space + 1, at + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq !== -1) records.set(record.slice(0, eq), record.slice(eq + 1));
    at += length;
  }
  return records;
}

/**
 * The contents of every regular file and symlink in a gzipped ustar/pax tarball, as GitHub's
 * `git archive` writes it. Paths, modes and the top directory are left to the caller's listing of
 * the tree; directories, the global pax header carrying the commit sha, and other kinds are skipped.
 */
export function readTarball(gzipped: Buffer): TarBlob[] {
  const tar = gunzipSync(gzipped);
  const files: TarBlob[] = [];
  let pax = new Map<string, string>();
  let longLink: string | undefined;
  for (let at = 0; at + BLOCK <= tar.length; ) {
    const header = tar.subarray(at, at + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0x30);
    const body = tar.subarray(at + BLOCK, at + BLOCK + size);
    if (body.length < size) throw new Error("the tarball ends mid-file");
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "g") continue;
    if (type === "x") {
      pax = paxRecords(body);
      continue;
    }
    if (type === "K") {
      longLink = text(body, 0, body.length);
      continue;
    }
    if (type === "L") continue;
    const link = pax.get("linkpath") ?? longLink ?? text(header, 157, 100);
    pax = new Map();
    longLink = undefined;
    if (type === "0" || type === "\0" || type === "7") {
      files.push(Buffer.from(body));
    } else if (type === "2") {
      files.push(Buffer.from(link));
    }
  }
  return files;
}
