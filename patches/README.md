# Core patch delivery

The supported desktop target is Windows with pi in VS Code's integrated terminal.
The existing Linux CI runner validates the tests; macOS support is outside scope.

This patch removes the vertical padding above and below user messages. It changes
only the audited bundled UI code in npm pi **0.85.1**. It does not change credentials,
settings, sessions, model execution, or tools.

## Inspect and apply

Run these commands from pi-remoticon. Replace `<package-root>` with the actual
`@earendil-works/pi-coding-agent` package directory. Every command requires a target;
there is no default installation and no startup or postinstall patching.

```text
npm run core-patch -- status --target "<package-root>"
npm run core-patch -- check --target "<package-root>"
npm run core-patch -- apply --target "<package-root>"
```

`status` and `check` are read-only. They report the canonical installation path,
version, patch state, source digest, manifest location, and recovery phase.
`check` refuses interrupted, legacy, or unsupported states. Before `apply` or
`restore`, close pi using that installation. The command checks running processes
and refuses an affected installation, reporting PIDs without printing prompts or
command lines. It never kills processes. If process inspection is unavailable,
restore process-query access before retrying; do not bypass that refusal.

The global Windows package is normally under
`%APPDATA%\npm\node_modules\@earendil-works\pi-coding-agent`. Confirm the actual path
instead of assuming it. Keep the repository dependency pristine: tests copy it to
temporary directories and patch those copies only.

## Restore and recover

With pi closed:

```text
npm run core-patch -- restore --target "<package-root>"
npm run core-patch -- status --target "<package-root>"
```

Restore returns the original user-message padding. Reopen pi to inspect it, close
pi again, then run `apply` to restore the thin bar. Backups remain available after
restore under `<package-root>/.pi-remoticon-patch/backups`; the manifest stays at
`<package-root>/.pi-remoticon-patch/manifest.json` with phase `restored`.

States have specific meanings:

- `pristine`: audited original files, optionally with a completed restore record.
- `current managed`: audited thin-bar files and a manifest matching this source.
- `older managed`: the same supported thin-bar fingerprints with a different
  recorded source digest. Apply rebuilds from verified original bytes.
- `legacy thin-bar-only`: the exact earlier thin-bar output without a manifest.
  Run restore first. It reconstructs the original, verifies its literal audited
  hash, and saves that verified recovery backup before replacement.
- `interrupted managed`: incomplete operation or leftover operation lock. Close
  pi and run restore. A lock belonging to a live process is never removed.
- `unsupported/drifted`: unknown bytes, version, graph, backup, or manifest.
  Preserve the installation and metadata for inspection. Do not delete metadata
  to force application. A pi upgrade needs a fresh audit; an exact-version
  reinstall is a separate user-approved recovery action.

All edits are planned before writes. The script follows actual static and literal
dynamic imports from `dist/bundle/cli.js`, including local JS worker URLs. It
verifies the whole-file dependency fingerprint, discovers the UI chunk through
that graph, checks exact anchors, stages sibling JavaScript, and runs `node --check`.
It flushes original backups and a phase manifest before replacing files. Each file
replacement is atomic; the whole transaction is not. A replacement failure attempts
every original restoration and reports each failure. Unknown concurrent edits are
preserved. Interrupted states must be recovered before a new apply.

## Maintained source and attribution

Pure validation and edits live in `scripts/core-patch-plan.ts`; filesystem and
process operations live in `scripts/apply-core-patch.ts`. The literal original and
legacy patched hashes are retained independently of the current definitions. S0
has no historical transform beyond the earlier thin-bar patch and no runtime
factory to compile.

The small matching excerpts come from
[`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi),
MIT licensed, copyright Mario Zechner. They are reproduced to locate the patch
target. Retain this notice with adapted upstream code.

## Windows test dependency repair

With tests stopped, run `npm run test:setup` after `npm ci`. This explicit setup
command repairs only the repository's root `node_modules/node-pty` version 1.1.0.
It never selects global pi or pi's nested node-pty. On other platforms the command
reports that the repair is not needed.

The Windows cleanup race closes the console before its process-list helper can
attach. The maintained repair in `scripts/repair-test-pty.ts` moves native console
closure and output-worker disposal into the existing process-list callback, after
the owned console processes are handled. It keeps node-pty's normal cleanup path
and does not suppress stderr.

The command rejects linked packages/files, unknown versions, and unknown complete
file hashes. It stages the audited replacement, runs `node --check`, rechecks the
destination, and replaces that one file atomically. Repeating setup is harmless.
After an interrupted setup, rerunning it removes a leftover stage only when its
whole-file hash matches the audited repair. Unknown staged bytes are preserved
and refused, with an instruction to inspect them and restore through `npm ci`.
`npm ci` restores the original test dependency; rerun setup afterward when testing
on Windows. This repair has no pi patch manifest and changes no pi installation.

The adapted cleanup excerpt is from node-pty, MIT licensed, copyright 2012-2015
Christopher Jeffrey. Its original MIT license remains in the installed package.
Original SHA256 is `8636d16b38266112204061a22b135734177c242837982fd3a4055be726efa64a`;
repaired SHA256 is `4a03e43ab60106322b822397e217340a0882c7e531c2f2110a737e84a7e6a55d`.
