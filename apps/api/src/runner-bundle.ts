import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { RUNNER } from "./provision.js";
import { execInSprite, type SpriteOps, writeSpriteFile } from "./sprites.js";

/**
 * Puts the runner bundle at `RUNNER` in a sprite, uploading only when its checksum differs. The
 * bundle ships with this build of the API, so it is read once, again only after a failed read.
 */
export function createBundleInstaller(sprites: SpriteOps, bundlePath: string) {
  let bundle: Promise<{ bytes: Buffer; sha256: string }> | undefined;
  const loadBundle = () => {
    bundle ??= readFile(bundlePath).then((bytes) => ({
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }));
    bundle.catch(() => {
      bundle = undefined;
    });
    return bundle;
  };

  return async function ensureBundle(
    spriteName: string,
    tag: string,
  ): Promise<void> {
    const { bytes, sha256 } = await loadBundle();
    const current = await execInSprite(
      sprites,
      spriteName,
      ["sha256sum", RUNNER],
      { op: "sha256sum" },
    );
    const onSprite = current.exitCode === 0 ? current.stdout.split(" ")[0] : "";
    if (onSprite === sha256) return;
    // a rename is atomic, so a concurrent launch's node reads the old bundle or the new, never half
    // of one; the temp path is per caller (a run id or a provisioning), so two uploads never write
    // the same file
    const staged = `${RUNNER}.${tag}`;
    await writeSpriteFile(sprites, spriteName, staged, bytes, {
      op: "write-bundle",
    });
    const moved = await execInSprite(
      sprites,
      spriteName,
      ["mv", "-f", staged, RUNNER],
      { op: "mv-bundle" },
    );
    if (moved.exitCode !== 0) {
      throw new Error(
        `installing the runner bundle failed: ${moved.stderr.trim()}`,
      );
    }
  };
}

export type BundleInstaller = ReturnType<typeof createBundleInstaller>;
