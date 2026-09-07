// Apply the calm-UI core patch to an installed copy of pi.
//
// WHY THIS EXISTS (P0). Three UI facts pi exposes no extension hook for — the
// transcript state dots (S3), the showStatus() exposure the dynamic line needs
// (S3), and the user-message bar height (P0) — can only be changed by editing
// pi's own installed files. INTENT accepts that on one condition: the edits are
// carried by a maintained, drift-guarded patch, never hand-edits. This is that
// mechanism; P0 proves it against the smallest real target (the bar height).
//
// WHERE THE CODE ACTUALLY LIVES. The running pi is `dist/bundle/cli.js`, which
// imports only from `dist/bundle/chunks/*.js`. The loose `dist/modes/**` tree is
// orphaned build output the runtime never loads — INTENT/spec cite it, but
// patching it changes nothing. So every `find` string is the *bundled* (minified,
// condensed) form and we scan the chunks dir. The chunk filename is a content
// hash that moves on every pi build, so we NEVER hardcode it — we locate the one
// chunk that contains the find-string.
//
// MIT: the `find` excerpts are short substrings of @earendil-works/pi-coding-agent
// (MIT © Mario Zechner). See patches/README.md.
//
// USAGE:
//   tsx scripts/apply-core-patch.ts [targetPackageDir]
// targetPackageDir defaults to the local devDependency package. After a real
// `pi update`, the user runs this by hand pointed at the GLOBAL install package,
// because `npm i -g pi` cannot know about this patch.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

// The default target: the pi package inside this repo's node_modules. No
// machine-absolute path (Static-lane guard) — the layout is stable.
export const DEFAULT_TARGET = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent");

// The chunks directory, relative to a pi package root.
export const CHUNKS_SUBDIR = join("dist", "bundle", "chunks");

export interface PatchEntry {
  /** Human name for logs/errors — which locked decision this carries. */
  readonly name: string;
  /** Exact bundled substring to locate. Must occur exactly once across all chunks. */
  readonly find: string;
  /** Replacement text. Presence of this string means "already applied". */
  readonly replace: string;
}

// The patch list. P0 ships one entry: the user-message bar's vertical padding.
// Box(paddingX, paddingY) — outputPad is horizontal, the literal 1 is vertical.
// 1 -> 0 makes the bar thin (INTENT.md user-message-bar height decision).
export const PATCHES: readonly PatchEntry[] = [
  {
    name: "user-message-bar-height",
    find: `new Box(this.outputPad,1,content=>theme.bg("userMessageBg",content))`,
    replace: `new Box(this.outputPad,0,content=>theme.bg("userMessageBg",content))`,
  },
];

export type EntryDecision =
  | { readonly kind: "already-applied" }
  | { readonly kind: "apply"; readonly file: string; readonly next: string };

/**
 * Decide what to do with one entry given every chunk's current content.
 * Pure — no file I/O — so the whole guard logic is unit-testable.
 *
 * files: chunk filename -> content.
 * Throws (loudly, naming the entry + string) when the target is missing or
 * ambiguous; that loud failure IS the drift guard — a pi update that condenses
 * or moves the target trips it here, never a silent no-op.
 */
export function decideEntry(files: ReadonlyMap<string, string>, entry: PatchEntry): EntryDecision {
  // Idempotency first: if the replacement is already present anywhere, this entry
  // is done. Checked before `find`, because after a successful apply the `find`
  // string is gone (count 0) and would otherwise look like drift.
  for (const content of files.values()) {
    if (content.includes(entry.replace)) return { kind: "already-applied" };
  }

  // Count `find` across all chunks. Exactly one hit in exactly one file is the
  // only acceptable state.
  const hits: string[] = [];
  for (const [file, content] of files) {
    let idx = content.indexOf(entry.find);
    while (idx !== -1) {
      hits.push(file);
      idx = content.indexOf(entry.find, idx + entry.find.length);
    }
  }

  if (hits.length === 0) {
    throw new Error(
      `[apply-core-patch] "${entry.name}": target string not found in any chunk.\n` +
        `  Looked for: ${entry.find}\n` +
        `  This is the drift guard firing: pi likely moved or rewrote this code. ` +
        `Update the find-string for "${entry.name}" to match the new pi source.`
    );
  }
  if (hits.length > 1) {
    throw new Error(
      `[apply-core-patch] "${entry.name}": target string is ambiguous — found ${hits.length} ` +
        `times (in ${[...new Set(hits)].join(", ")}). Refusing to patch. Make the find-string more specific.`
    );
  }

  const file = hits[0];
  const content = files.get(file)!;
  return { kind: "apply", file, next: content.replace(entry.find, entry.replace) };
}

/** Read every *.js chunk from a pi package's chunks dir into a filename->content map. */
export function readChunks(pkgDir: string): Map<string, string> {
  const chunksDir = join(pkgDir, CHUNKS_SUBDIR);
  const files = new Map<string, string>();
  for (const name of readdirSync(chunksDir)) {
    if (name.endsWith(".js")) files.set(name, readFileSync(join(chunksDir, name), "utf8"));
  }
  if (files.size === 0) {
    throw new Error(`[apply-core-patch] no .js chunks under ${chunksDir} — is this a pi package dir?`);
  }
  return files;
}

/** Apply every patch entry to a pi package on disk. Returns a per-entry log. */
export function applyCorePatch(pkgDir: string = DEFAULT_TARGET): { name: string; status: EntryDecision["kind"] }[] {
  const files = readChunks(pkgDir);
  const log: { name: string; status: EntryDecision["kind"] }[] = [];
  for (const entry of PATCHES) {
    const decision = decideEntry(files, entry);
    if (decision.kind === "apply") {
      writeFileSync(join(pkgDir, CHUNKS_SUBDIR, decision.file), decision.next);
      files.set(decision.file, decision.next); // keep the in-memory map consistent for later entries
    }
    log.push({ name: entry.name, status: decision.kind });
  }
  return log;
}

// Run when invoked directly (not when imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = process.argv[2] ?? DEFAULT_TARGET;
  const log = applyCorePatch(target);
  for (const { name, status } of log) {
    console.log(`  ${status === "apply" ? "patched" : "already applied"}: ${name}`);
  }
  console.log(`[apply-core-patch] done (${target})`);
}
