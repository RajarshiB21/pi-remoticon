// P0 integration-lane support: make throwaway copies of the installed pi package
// so the drift guard can boot a PATCHED copy and a PRISTINE copy and prove it can
// tell them apart. Never patches the devDependency in place — that would leave no
// pristine source for the negative half of the guard.
import { cpSync, rmSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// A fixture source, never a default production mutation target.
export const PRISTINE_SOURCE = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent", import.meta.url));

export interface PiCopy {
  /** The copied pi *package* dir (pass to applyCorePatch). */
  readonly pkgDir: string;
  /** The copy's CLI entry (pass to bootPi's piCli arg). */
  readonly cli: string;
  /** Remove the copy. Call in a finally. */
  readonly cleanup: () => void;
}

/**
 * Copy the repo's installed pi package to a fresh temp dir. Each call is a
 * separate, pristine, never-patched copy — the negative drift test needs its own,
 * distinct from the copy the positive test patched, so patched state can never
 * leak between them.
 */
export function makePiCopy(): PiCopy {
  const root = mkdtempSync(join(tmpdir(), "pi-copy-"));
  const pkgDir = join(root, "pi-coding-agent");
  // Copy dist/ (19MB — where the patch lands: dist/bundle/chunks/*) and
  // package.json. SYMLINK the 398MB node_modules instead of copying: the bundle
  // needs it at runtime (node-pty etc.) but the patch never touches it, so a
  // shared read-only link is safe and keeps the two per-run copies fast (well
  // under the CI ceiling). Junction on Windows (no admin needed); dir link else.
  cpSync(join(PRISTINE_SOURCE, "dist"), join(pkgDir, "dist"), { recursive: true });
  cpSync(join(PRISTINE_SOURCE, "package.json"), join(pkgDir, "package.json"));
  symlinkSync(join(PRISTINE_SOURCE, "node_modules"), join(pkgDir, "node_modules"), platform() === "win32" ? "junction" : "dir");
  return {
    pkgDir,
    cli: join(pkgDir, "dist", "bundle", "cli.js"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Count viewport rows painted with the user-message bar background (RGB). One
 *  row per text line plus one per vertical pad row; the patch removes the pads. */
export function countBarRows(screenRows: { bg: { r: number; g: number; b: number } | null }[][], rgb: { r: number; g: number; b: number }): number {
  let n = 0;
  for (const row of screenRows) {
    if (row.some((cell) => cell.bg && cell.bg.r === rgb.r && cell.bg.g === rgb.g && cell.bg.b === rgb.b)) n++;
  }
  return n;
}
