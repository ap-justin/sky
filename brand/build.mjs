// derives every sky brand file from the hand-drawn masters in this directory.
// run from the repo root: node brand/build.mjs (needs rsvg-convert for the pngs)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(dir, f), "utf8");
const inner = (f) =>
  read(f)
    .replace(/^\s*<svg[^>]*>/, "")
    .replace(/<title>.*?<\/title>/, "")
    .replace(/<\/svg>\s*$/, "");
const write = (f, s) => writeFileSync(join(dir, f), `${s.trim()}\n`);
const paint = (s, c) => s.replaceAll("currentColor", c);
const png = (svg, out, ...size) =>
  execFileSync("rsvg-convert", [...size, join(dir, svg), "-o", join(dir, out)]);

const INK = "#16181D";
const LIGHT = "#F7F6F2";

const mark = inner("sky-mark.svg");
// wordmark is Inter 600 outlined (OFL), in font units: baseline y0, ascender top y-1490
const word = inner("sky-wordmark.svg");

// mark in fixed colours: -light sits on light ground, -dark on dark ground
write(
  "sky-mark-light.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><title>sky</title>${paint(mark, INK)}</svg>`,
);
write(
  "sky-mark-dark.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><title>sky</title>${paint(mark, LIGHT)}</svg>`,
);

// horizontal lockup: disc height = ascender top (y4) to baseline (y28), plus 2.5% overshoot so the
// round form reads as tall as the flat-topped k beside it
const S = 24 / 1490;
const DISC = 24 * 1.025;
const M = DISC / 28;
const WORD_X = DISC + 0.4 * 24;
const markInLockup = `<g transform="translate(${-2 * M} ${16 - 16 * M}) scale(${M})">${mark}</g>`;
const wordInLockup = `<g transform="translate(${WORD_X - 61.6 * S} 28) scale(${S})">${word}</g>`;
const W = Math.ceil(WORD_X + (3137.9 - 61.6) * S);
const lockup = `${markInLockup}${wordInLockup}`;
write(
  "sky-lockup.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 35"><title>sky</title>${lockup}</svg>`,
);

// readme headers, one per github theme
for (const [name, c] of [
  ["light", INK],
  ["dark", LIGHT],
]) {
  write(
    `sky-header-${name}.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 ${W + 8} 43" width="${(W + 8) * 3}" height="129"><title>sky</title>${paint(lockup, c)}</svg>`,
  );
}

// social preview, 1280x640: lockup reversed on ink
const SP = 200 / 32;
write(
  "sky-social-preview.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 640"><title>sky</title><rect width="1280" height="640" fill="${INK}"/><g transform="translate(${(1280 - W * SP) / 2} ${320 - 16 * SP}) scale(${SP})">${paint(lockup, LIGHT)}</g></svg>`,
);

png("sky-mark-light.svg", "sky-mark-512.png", "-w", "512", "-h", "512");
png(
  "sky-social-preview.svg",
  "sky-social-preview.png",
  "-w",
  "1280",
  "-h",
  "640",
);
png("sky-tile.svg", "sky-tile-512.png", "-w", "512", "-h", "512");
