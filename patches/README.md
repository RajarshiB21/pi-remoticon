# Core patches

The `find` strings in `../scripts/apply-core-patch.ts` are short excerpts of
[`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi), MIT licensed,
© Mario Zechner — reproduced here only to locate patch targets, permitted under MIT provided this
notice is retained.

## What the patch does and why

pi exposes no extension hook for a few transcript-render facts the calm-UI foundation needs, so those
edits are carried as a maintained patch against pi's installed files. P0 ships one entry: the
user-message bar's vertical padding (`Box(paddingX, paddingY)` → `paddingY 1 → 0`, a thin bar).

The running pi loads `dist/bundle/cli.js` → `dist/bundle/chunks/*.js`; the loose `dist/modes/**` tree
is orphaned build output the runtime never loads, so patches target the **bundled** code. The chunk
filename is a content hash that changes on every pi build, so the script locates the chunk by its
contents, never by name.

## Running it

```sh
node scripts/apply-core-patch.ts [targetPackageDir]
```

- No argument → patches this repo's local devDependency copy of pi. **Heads-up before using
  this form:** the integration drift guard boots its pristine (negative) copy FROM that same
  devDependency, so a devDependency patched by hand makes the negative test fail loudly (it expects
  the original tall bar and gets the thin one). That is the guard working, not a broken install —
  restore the pristine source with `npm ci`.
- **After every real `pi update`**, run it by hand pointed at the global install package, e.g.
  `node scripts/apply-core-patch.ts "$APPDATA/npm/node_modules/@earendil-works/pi-coding-agent"`.
  `npm i -g` cannot trigger this patch, so it is a documented manual step.

The script is idempotent (re-running reports "already applied") and fails loudly, naming the missing
string, if pi moved the target — that failure is the drift guard, not a crisis: update the find-string
to match pi's new source. It also fails loudly on an *inconsistent* state (the replacement already
present somewhere while an original target still exists — pi duplicated or partially moved the code),
never reporting "already applied" while an unpatched site remains.
