# Implementation plan — per-call tool blocks (Structure C)

Visual authority: [`tool-call-blocks.svg`](./tool-call-blocks.svg). Prose contract: [`tool-call-blocks-spec.md`](./tool-call-blocks-spec.md).

This is the hand-off document for the Builder. It is deliberately concrete: exact
strings, exact colours, exact data fields, and the exact list of test assertions
that must change. A weaker model should be able to execute it without guessing.

---

## 0. Scope (what changes, what does not)

**One source file changes:** `patches/runtime/tool-group.ts`.

**Four test files change** (exact edits in §8):

1. `test/tool-groups.test.ts`
2. `test/core-patch-transaction.test.ts`
3. `test/patch-regression.integration.test.ts`
4. `test/s3-footer.integration.test.ts`

**Nothing else changes.** No theme tokens, no `skill.ts`, no `assistant.ts`, no
research/fetch code, no sidebar/footer/header, and — critically — no model-facing
or stored data. This is presentation only.

**The key rule that keeps everything else safe** (memorise this):

> An entry is rendered as a **per-call block** only when its tool is in the
> `operations` map (read, write, edit, bash, powershell, grep, find, ls).
> Every other tool (fetch, TaskCreate, unknown names, extension tools) keeps the
> **existing aggregate-summary path exactly as it is today**, including
> `groupSummary` (D5) and `inlineBody` self-painting.

This one rule preserves the fetch/research row, the skill rows, and the
extension-summary behaviour with zero changes to those code paths.

---

## 1. The rendering contract

### 1.1 Layout constants

```
pad   = " ".repeat(min(max(0, width), outputPad + 2))   // unchanged from today
```

- **Header** line = `pad + "●" + " " + Name + "(" + arg + ")"`  (or `pad + "●" + " " + Name` if no arg)
- **Branch** line = `pad + "  └ " + branchText`
- **Body** lines  = `pad + "    "` (i.e. pad+4 cols) + content

One blank line before each block, except the first in a run (the existing
`leadingBlank` logic already does this — keep it).

### 1.2 Colours

| Element | Colour |
|---|---|
| `●` (tool call) | `theme.fg("accent", "●")` → `#8abeb7` |
| tool name | `theme.bold(Name)` (bold, text colour) |
| `(` and `)` | `theme.fg("text", …)` |
| argument | `theme.fg("accent", arg)` |
| `└` | `theme.fg("dim", "└")` → `#92949e` |
| branch text (done/stopped) | `theme.fg("muted", …)` → `#a4a5ae` |
| branch text (failed) | `theme.fg("error", "failed · " + msg)` → `#e89891` |
| branch text (pending) | hard violet `\x1b[38;2;185;165;232m` (same as today's pending summary) |
| body gutter / truncation markers | `theme.fg("dim", …)` |
| body content | `theme.fg("muted", …)` |
| diff removed text | `theme.fg("toolDiffRemoved", …)` → `#e59b95` |
| diff added text | `theme.fg("toolDiffAdded", …)` → `#8fe0a6` |
| diff context text | `theme.fg("toolDiffContext", …)` |
| diff band bg (removed) | raw `\x1b[48;2;46;26;28m` → `#2e1a1c` |
| diff band bg (added) | raw `\x1b[48;2;21;42;30m` → `#152a1e` |

No yellow anywhere. Bands use raw RGB because the theme has no diff-background
role (only 7 named backgrounds exist and none is this).

### 1.3 Header argument per tool

| Tool | Display name | `arg` |
|---|---|---|
| write | `Write` | `args.path` |
| edit | `Update` | `args.path` |
| read | `Read` | `args.path` |
| bash | `Bash` | `args.command` |
| powershell | `PowerShell` | `args.command` |
| grep | `Grep` | `args.pattern` |
| find | `Find` | `args.pattern` |
| ls | `Ls` | `args.path` |
| anything else | capitalised toolName | first meaningful arg, else none |

The `arg` is the **raw** string from args (trimmed), not the resolved path. If
missing/empty, omit the `(…)` entirely. Clip the whole header with
`truncateToWidth(pad + styled, width, "")` (never wrap).

### 1.4 Branch text per tool and state

`failed` always → `failed · <message>` (message = the error text already computed
by `snapshot()`, whitespace-collapsed, ≤100 chars).

`stopped` always → `interrupted`.

`pending` → `Writing…` / `Editing…` / `running…` / `Reading…` / `searching…` /
`listing…` / `running…` (unknown), matching the `operations` map's `pending` field
(already present). `bash`/`powershell` use `running…` (the existing `noun: command`).

`done`:

| Tool | branch |
|---|---|
| write | `Wrote N lines to <path>` (N = line count of `args.content`) |
| edit | `Added A lines, removed R lines` (A/R counted from `details.diff`, §1.5) |
| read | `N lines` (N = line count of result text) — `1 line` for one |
| bash | `ran` |
| powershell | `ran` |
| grep | `N matches in M files` (N/M from §1.6) |
| find | `N paths` (N = non-empty lines in result text; `No matches` if none) |
| ls | `N entries` (N = non-empty lines in result text; `0 entries` if empty dir) |
| unknown | (never reaches here — unknown stays in the aggregate summary) |

Pluralisation: `1 line`/`N lines`, `1 match`/`N matches`, `1 file`/`M files`,
`1 path`/`N paths`, `1 entry`/`N entries`.

---

## 2. Diff rendering (Update blocks) — the heart of the change

### 2.1 Source

pi already computes the diff. `edit`'s settled result is:

```ts
result.details = { diff: <string>, patch: <string>, firstChangedLine: <number> }
```

`details.diff` is a newline-joined string of lines in **pi's native marker
format**:

```
+165 added line content
-165 removed line content
 165 context line content
    ...              ← elision between hunks (spaces + "...")
```

The sign is immediately followed by a **width-padded** line number, then a space.
`+` = added, `-` = removed, leading space = context. We re-mark to the approved
format (§2.3). **Do not invent a diff engine.**

### 2.2 Transform

Parse each line with regex `/^([+- ])(\d*)(?: (.*))?$/`. The elision line is the
one where the number field is empty and the text is `...`.

- Compute `W` = max digit-count of any parsed line number in the whole diff
  (min 1).
- Re-emit each line as: `sign` + `" "` + `num.padStart(W)` + `"  "` + content.
  So for W=3: `- 165  <content>`, `+ 165  <content>`, `  165  <content>`.
- `sign` = `-` (removed) / `+` (added) / ` ` (context).
- Elision line → emit `pad+4` + `…` (dim), no sign/number.

### 2.3 Colours, bands, and the 12-line cap

- **Removed**: fg `toolDiffRemoved`, full-width band bg `#2e1a1c`.
- **Added**: fg `toolDiffAdded`, full-width band bg `#152a1e`.
- **Context**: fg `toolDiffContext`, no band.
- **Word-level highlight** (confirmed requirement): when a single `-` line is
  immediately followed by a single `+` line (a 1:1 pair), compute the changed
  span = everything between the longest common prefix and longest common suffix
  of the two lines' content, and wrap that span in `theme.bold(…)` on both lines
  (stronger cue inside the band). Whole-line add/remove pairs (no common
  prefix+suffix) get no intra-line highlight. Skip this refinement if it is
  unparseable — the band is still correct.
- **Full-width band**: after building the styled line, pad it with spaces to
  `width` so the band runs edge-to-edge, then `\x1b[49m` reset. Compute the
  visible width with a local helper (§4). Clip first with `truncateToWidth`, then
  pad; a line longer than `width` is clipped with a trailing `…` (never wrapped).
- **Cap**: render at most **12 diff lines** (added+removed+context+elision, in
  order). If the diff has more, print the first 12 and append one dim line
  `pad+4` + `⋯ +N more changed lines hidden`, where N = the number of
  added+removed lines beyond the first 12.

---

## 3. Write preview and command tail

### 3.1 Write body

`args.content` is the full new file text. N = number of lines (split on `\n`;
trailing empty line not counted). Body = first **10** lines, numbered:

```
pad+4 + String(i).padStart(W) + "  " + content
```

where `W` = digits of N (min 1), i = 1..10. Tabs → 3 spaces. If N > 10 append a
dim line `pad+4` + `… +<N-10> lines`.

### 3.2 Bash / PowerShell body

Body = last **5** lines of the result text (split `\n`, trim trailing empty).
If there were more than 5, prepend a dim line `pad+4` + `… <earlier> earlier lines`.
No output → no body. Ignore the trailing `[Showing lines …]` truncation note
when counting the tail (strip it before splitting).

---

## 4. Code changes in `patches/runtime/tool-group.ts`

### 4.1 Local helpers to add

```ts
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const visible = (s: string) => [...stripAnsi(s)].length;   // code-point safe
```

### 4.2 Extend `Snapshot`

Add fields, all derived in `snapshot()` (bounded, see §4.3):

```ts
interface Snapshot {
  name: string; state: "pending" | "done" | "failed" | "stopped";
  error: string; path?: string; skill?: SkillState;
  groupSummary?: string; inlineBody?: boolean;
  // NEW:
  arg?: string;            // display arg (§1.3), raw trimmed
  command?: string;        // bash/powershell
  writeTotal?: number;     // write line count (N)
  writeHead?: string[];    // first ≤10 write lines, tabs→spaces
  diffW?: number;          // W (§2.2)
  diffLines?: { sign: "-" | "+" | " "; num: string; text: string }[];  // first ≤12
  diffHidden?: number;     // changed lines beyond the 12-line cap
  resultLines?: number;    // read/grep/find/ls line count (see §1.4)
  grepFiles?: number;      // grep distinct files
  grepMatches?: number;    // grep match lines
  tail?: string[];         // last ≤5 bash/powershell lines
  tailEarlier?: number;    // lines above the tail
}
```

### 4.3 `snapshot()` additions (exact sources)

- `arg`: per §1.3 from `row.args`.
- `command`: `args.command` (bash/powershell).
- `writeTotal` / `writeHead`: from `args.content` when tool is `write`.
- `diffW` / `diffLines` / `diffHidden`: parse `row.result.details.diff` when tool
  is `edit` (§2.2). Store only the first 12 parsed lines + hidden count (keeps
  the snapshot bounded — never retain the full diff).
- `resultLines`: count of lines in joined result text (strip the trailing
  `[N more lines…]`/`[Showing …]` notice first).
- `grepMatches` / `grepFiles`: parse result text lines. Match line format is
  `<path>:<line>: <text>` (context lines are `<path>-<line>- <text>`). Count
  `:`-separated lines as matches; distinct `<path>` prefixes as files.
- `tail` / `tailEarlier`: last 5 lines of bash/powershell result text (§3.2).
- `diffHidden`: count of `+`/`-` lines beyond the first 12.

All `result.content` reads keep using the existing text-block extraction (join
`content[].text`). Keep the existing `error`, `path`, `partial`, `skill`,
`groupSummary`, `inlineBody` logic untouched.

### 4.4 `Group.render()` rewrite (the core)

Keep: the `dirty`-gated segment rebuild, skill-segment handling, `leadingBlank`,
`expanded`, and the `setExpanded`/`setShowImages`/`setImageWidthCells`/`invalidate`
methods exactly as they are.

Change only the per-segment *line emission*:

1. Build the **aggregate summary from UNKNOWN entries only**. Reuse the existing
   `counts`/`ordered`/`parts` code, but skip any entry whose tool is in
   `operations` (and skip skill entries — they already force their own segment).
   `groupSummary` (D5) entries are already custom-pushed and stay.
2. If the segment has any unknown entries, emit the summary line as today (with
   the same pending-violet / error styling), and its error detail line.
3. Then iterate the segment's entries **in original order** and emit, per entry:
   - known tool → the per-call block (header + branch + body);
   - `inlineBody` entry → `entry.row.render(width)` (unchanged self-paint);
   - unknown entry without inlineBody → nothing (it is already in the summary).
4. `segment.headerY` = index of the first emitted line of the segment (the
   summary line if present, otherwise the first block's header line). This is the
   click target.
5. Expanded (`segment.expanded`) → render native `segment.body.render(width)` for
   all entries, exactly as today.

The per-call block is built from `snapshot` + `args` + `result` only — **never**
by calling `entry.row.render(width)` while collapsed. This is what keeps the
native-render-caching tests green.

### 4.5 Mouse handling

Unchanged in mechanism; only `headerY` moves (now the summary line or the first
block header). Clicking it toggles the whole segment, same as today. Ctrl+O
(group-level expand) still works through `setExpanded`.

---

## 5. What must stay byte-identical

- `patches/runtime/skill.ts` — untouched.
- The fetch/research row (unknown tool → aggregate summary + `inlineBody`).
- The assistant presenter (`●` white, reasoning violet) — untouched.
- The theme JSON — untouched (bands are raw RGB in the patch).
- `scripts/runtime-patches.ts` injection — **no signature change required**
  (all helpers are local to tool-group.ts).

---

## 6. Non-obvious gotchas (read before coding)

1. **`package.json` is both a header and a body.** The GROUPTOOLS/RESTORE
   fixtures read `path: "package.json"`. Under Structure C the collapsed header
   `● Read(package.json)` itself contains the string `"package.json"`, so any
   test predicate that treats `"package.json"` as "only visible when expanded"
   silently breaks. §8 fixes those predicates to a *content-only* marker
   (`"offline-tool-fixture"`).
2. **Unknown tools keep the aggregate.** Do not turn `fetch`/`TaskCreate`/odd
   names into blocks. The rule in §0 is load-bearing for 5+ tests.
3. **Pending is violet, not accent.** The existing tests assert the hard violet
   escape `\x1b[38;2;185;165;232m` for pending. Keep that exact escape on the
   pending branch text so those assertions survive.
4. **Collapsed blocks must not call `row.render`.** The 300-row perf test and
   the "renders === 0" assertions fail otherwise.
5. **`edit` renders as `Update`** in the header and `update` in no other place.
6. **Diff marker spacing** is `- 165` (sign + space + number), not pi's `-165`.
   The re-mark transform in §2.2 is mandatory — that is the approved visual.

---

## 7. Verification commands

```
npx vitest run test/tool-groups.test.ts test/core-patch-transaction.test.ts
npx vitest run test/assistant-presentation.test.ts test/remoticon-theme.test.ts   # must stay green untouched
npm run typecheck
npm run lint
# integration (needs npm run test:setup once, then):
npx vitest run test/patch-regression.integration.test.ts test/s3-footer.integration.test.ts test/research-integration.test.ts
```

Full suite: `npm test`.

---

## 8. Exact test edits

### 8.1 `test/tool-groups.test.ts`

**Test 1 — "keeps skills compact…"** (one line changes):

- `expect(plain().match(/Reading 1 file/g)).toHaveLength(2);`
  → `expect(plain()).toContain("Read(ordinary.txt)");`
  → add `expect(plain()).toContain("Read(references/guide.md)");`

Everything else in test 1 (skill lines, `hiddenRenders === 0`, expanded native
detail, native clicks, `Successfully loaded skill`, `Failed to load skill`,
`Stopped loading skill`, `Skill(folder)`, `   ● Skill`, replay equality) stays.

**Test 2 — "groups original rows across empty turns…"** (the big rewrite; keep
every structural assertion, change the summary-text ones):

| Before | After |
|---|---|
| `toContain("2 reads pending")` | `toContain("Reading…")` (a and b are pending reads) |
| `toContain("1 read failed")` | `toContain("failed · broken input")` |
| `toContain("broken input")` | keep (substring of the branch) |
| `toContain("1 write interrupted")` | `toContain("interrupted")` |
| `toContain("1 ${name} call pending")` (constructor/toString/`__proto__`) | keep (unknown → aggregate) |
| `[0]).toBe("    Reading 2 files · running 1 command")` | `[0]).toContain("Read(first.txt)")` |
| `[0]).toBe("    Read 2 files · ran 1 command")` | `[0]).toContain("Read(first.txt)")` |
| `not.toMatch(/[▸▾]/)` | keep |
| `[0]).toBe("")` / `[0]).not.toBe("")` (leading blank) | keep |
| `[0]).toMatch(/^ {2}Read/)` (outputPad 0) | `[0]).toMatch(/^ {2}● Read/)` |
| `failure[0]).toContain("Read 2 files · ran 1 command · 1 read failed")` | `failure.join("\n")).toContain("failed · denied")` |
| `failure[1]).toBe("    ! read: denied")` | delete (folded into `failed · denied`) |
| `toContain("Ran 2 searches · listed 2 directories")` | `toContain("Grep")` + `toContain("Find")` + two `Ls` headers |

Structural assertions kept verbatim: entry order, split at late assistant
content, `b.native instanceof ToolExecutionComponent`, native-result background
`\x1b[48;2;1;2;3m` (expanded), click-to-expand via the header, the 300-row
render-cache check, and `chat.clear()`/`add` grouping. Where the test clicks a
hard-coded `y`, replace with the header row found by `findIndex` on the rendered
lines (same technique test 1 already uses) so the coordinates never go stale.

**Test 3 — "extension-supplied group summary"** (mostly keeps; one assertion):

- Keep: `1 fetch call pending`, `Fetching 3 pages…`, `Fetched 3 pages · 1 dead end`,
  `Fetched 3 pages · 1 dead end · Fetched 2 pages`, and `not.toContain("Stopped")`.
- `toContain("Stopped · Fetched 3 pages · 1 dead end · Fetched 2 pages · 1 read interrupted")`
  → `toContain("Fetched 3 pages · 1 dead end · Fetched 2 pages")` (unchanged)
  + `toContain("Read(a.ts)")` + `toContain("interrupted")`.

**Test 4 — "paints a row that asks to paint itself"** — no changes (fetch summary
+ inlineBody preserved; ordinary read block contains no `"read body"`).

### 8.2 `test/core-patch-transaction.test.ts`

In `assertPatchedToolFlow`, the `[state, expected]` tuples:

| Before | After |
|---|---|
| `["pending", "1 read pending"]` | `["pending", "Reading…"]` |
| `["done", "1 read completed"]` | `["done", "1 line"]` |
| `["failed", "1 read failed"]` | `["failed", "failed · broken input"]` |
| `["stopped", "1 read interrupted"]` | `["stopped", "interrupted"]` |

Keep `if (state === "failed") expect(plain(group)).toContain("broken input")`
(now satisfied by the branch). In the split section:

- `expect(plain(split)).toContain("1 read failed")` → `toContain("failed · failed then continued")`
- `expect(plain(split)).toContain("1 read pending")` → `toContain("Reading…")`

All structural assertions (row instanceof ToolExecutionComponent, entry order,
split) stay.

### 8.3 `test/patch-regression.integration.test.ts`

- `const header = term.findAllText(/Read \d+ file/)[0]` → `term.findAllText(/Read\(/)[0]`
- `const expanded = () => term.viewport.getText().includes("package.json")`
  → `const expanded = () => term.viewport.getText().includes("offline-tool-fixture")`

(The collapsed header is `Read(package.json)`, so `"package.json"` is now always
present; the read's *content* `{"name":"offline-tool-fixture",…}` appears only
when expanded. The `[true,false,true]` toggle logic is otherwise unchanged.)

### 8.4 `test/s3-footer.integration.test.ts`

GROUPTOOLS section:

- `waitFor("Read 1 file", 5000)` (line 46) → `waitFor("Read(package.json)", 5000)`
- `press("Ctrl+O")` then `waitFor("package.json", 5000)` → `waitFor("offline-tool-fixture", 5000)`
- `press("Ctrl+O")` then `waitFor("Read 1 file", 5000)` → `waitFor("Read(package.json)", 5000)`
- `waitFor("Read 1 file", 5000)` (after `/reload`, line 55) → `waitFor("Read(package.json)", 5000)`

RESTORE section:

- `waitFor("Read 2 files · ran 1 command", 10000)` → `waitFor("Read(package.json)", 10000)`
- `expect(rows[commentary + 1]).toContain("Read 2 files · ran 1 command")`
  → `expect(rows[commentary + 1]).toContain("● Read(package.json)")`
- The alignment assertion `rows[commentary + 1].indexOf("Read") === rows[commentary].indexOf("I'll")`
  stays (both are `● ` + text, index 2).
- `term.click(rows[commentary + 1].indexOf("Read"), commentary + 1)` stays (first
  block header is the toggle target); `waitFor("restoration-fixture")` stays
  (bash output only in expanded native view).
- `waitFor("Read 2 files · ran 1 command", 3000)` → `waitFor("Read(package.json)", 3000)`

The SKILLREAD section (from line 90 on) is untouched — skills render identically.

---

## 9. Order of operations for the Builder

1. Edit `patches/runtime/tool-group.ts` (§4 + §2 + §3).
2. Run `npx vitest run test/tool-groups.test.ts test/core-patch-transaction.test.ts` and fix.
3. Run `npx vitest run test/assistant-presentation.test.ts test/remoticon-theme.test.ts` — must be green untouched.
4. Apply the exact test edits in §8.3 and §8.4, then run those two integration files.
5. `npm run typecheck` and `npm run lint`.
6. Full `npm test`.

## 10. Open items (defaults chosen; confirm if you want otherwise)

1. **Running colour**: pending branch stays violet (spec §11 item 1 recommended
   accent — one constant to flip if you prefer).
2. **Duration on shell branches**: omitted (`ran`), because pi keeps its timer
   private and exit code is not in the UI result (spec §11 item 2).
3. **Rewrite vs preview for `write`**: content preview for all writes (spec §11
   item 3, recommended).
4. **Word-level highlight**: bold changed span inside bands (spec §11 item 4,
   confirmed).
5. **Budgets**: 4 context lines / 12-line diff cap / 10-line write preview /
   5-line command tail (spec §11 item 5, confirmed).
6. **Blank line between blocks**: kept (spec §11 item 6, recommended).
7. **Long runs**: one block per call, no fallback summary (spec §11 item 7).
8. **Light theme**: fixed dark bands accepted (spec §11 item 8, recommended).
