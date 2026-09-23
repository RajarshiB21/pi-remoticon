# Tool calls in the transcript — specification

Visual reference: [`tool-call-blocks.svg`](./tool-call-blocks.svg) (the settled state).

This document describes how a run's tool calls should appear in the remoticon
transcript. It is written to be read without the code in front of you. It ends
with a numbered list of decisions that are still open, so you can spot a gap
before implementation starts.

---

## 1. The problem today

While the agent works, its tool calls are collapsed into a single summary line:

```
● I'll run a few different tool commands so you can see the UI.

Reading 1 file, listing 1 directory, running 1 shell command…
```

Nothing else. The command that ran, the file that was touched, and the diff that
pi already computed are all hidden behind Ctrl+O or a click. The information
exists on screen — it is simply not painted until you expand. You asked for the
work to be visible as it happens without losing the calm look.

## 2. What changes

Each tool call becomes its own small block, in order, directly under the
assistant message that requested it. A block is three things: a **header** line
that names the call, a **branch** line that says what happened, and an optional
**body** that shows the smallest useful slice of the work — a snippet of a written
file, the changed region of a diff, the tail of a command's output. Assistant
prose keeps its white `●`; tool calls use the accent `●`. That colour break is
the whole isolation mechanism: you can tell at a glance which lines are the
assistant speaking and which are the agent working.

Nothing else in the interface changes: the user bar, header, footer, sidebar,
task panel, thinking block, fetch tree and skill rows all stay as they are.

## 3. The block, line by line

```
● Write(docs\cont-ui-overall\mockup.html)          ← header
  └ Wrote 191 lines to docs\cont-ui-overall\mockup.html   ← branch
       1  <title>pi UI mockups</title>            ← body (indented under the branch text)
       2  <style>
       …
      10      --dim:#6f6f6f;
          … +181 lines                          ← truncation marker
```

- **Header.** `●` in accent, tool name in bold, argument in accent. The argument
  is the file path for file tools and the command itself for shell tools. It is
  clipped to the terminal width with a trailing `…`.
- **Branch.** `└` in dim, then one muted line describing the outcome. This line
  is always present and is always one line.
- **Body.** Zero or more lines, indented to line up with the text after `└`
  (four columns in). What goes here depends on the tool; budgets are in §5–§7.
- **Spacing.** One blank line before each block, except the first. Blocks that
  belong to the same assistant message sit together; if you write prose in the
  middle of a run, the blocks after that prose begin a fresh run.
- **Pending / done / failed / interrupted.** A block appears the moment the call
  starts (pending), and updates in place when it settles. A failed call shows
  `└ failed · <message>` in the error colour. A run you stop shows
  `└ interrupted`.

## 4. Which tool shows what

| Tool | Header (argument) | Branch when done | Body |
|---|---|---|---|
| `write` | `Write(path)` | `Wrote N lines to path` | first 10 lines of the file, numbered |
| `edit` (shown as **Update**) | `Update(path)` | `Added A lines, removed R lines` | the diff, see §5 |
| `bash` | `Bash(command)` | `exit 0 · 1.2s` (see open item 2) | last 5 lines of output |
| `powershell` | `PowerShell(command)` | `exit 0 · 1.2s` | last 5 lines of output |
| `read` | `Read(path)` | `N lines` | none |
| `grep` | `Grep(pattern)` | `N matches in M files` | none |
| `find` | `Find(pattern)` | `N paths` | none |
| `ls` | `Ls(path)` | `N entries` | none |
| `fetch` | unchanged — the fetch tool paints its own tree | — | unchanged |
| a skill read | unchanged — skills already have this header/branch shape | — | unchanged |
| anything else | `Name(short argument summary)` | state in plain words | first 5 lines of output, if any |

While a call is pending its branch reads in the present tense (`Writing…`,
`Editing…`, `running…`, `Reading…`). An empty command produces no body at all.
An image or binary result produces `└ image` or `└ binary` and no body.

## 5. The diff view (Update blocks)

This is the part the reference image is really about.

- **Source.** pi already computes this diff for the `edit` tool: changed lines
  with a line number, roughly **4 lines of context** around each change, and `…`
  where it skipped a stretch that did not change. Today the group throws that
  away; we will paint it instead. We are not inventing a diff engine.
- **The band.** Every removed line gets a full-width dark-red band; every added
  line gets a full-width dark-green band. Context lines get no band. The band
  runs to the right edge of the transcript so the change reads as a block, which
  is what makes scanning fast.
- **Markers and numbers.** `- 165`, `+ 165`, `  165` in the existing pi layout, so
  the left edge tells you add / remove / context and the number tells you where.
- **Word-level highlight.** When a line is changed rather than added or removed,
  the specific words that differ get a stronger highlight inside the band. In
  the reference image, `chomp` inside the removed line is picked out this way.
  This is the "truncated to the part that matters" behaviour at line scale.
- **Trimming.** The whole diff prints at most **12 lines**. If there is more, the
  first hunk (or two) print and the rest is replaced by
  `⋯ +N more changed lines hidden`. Where pi elided unchanged context between
  hunks, that is already shown as `…`.
- **Colours.** Added text `#8fe0a6` on band `#152a1e`; removed text `#e59b95` on
  band `#2e1a1c`. The existing theme already has foreground roles for added and
  removed text, but it has no *background* role for a diff band — the theme
  system only allows seven named backgrounds, none of which is this. So the
  bands are fixed RGB values. That is a knowing trade: perfect on the dark
  remoticon theme, wrong on a light one (open item 8).
- **Width.** An over-long diff line is clipped with `…` at the right edge, never
  wrapped. Wrapping would break the band into two rows of different colours and
  destroy the scan.

## 6. The write preview

A brand-new file has no diff — the whole content is new — so the body is the
first **10 lines** of what was written, each with a line-number gutter, followed
by `… +N lines`. This is the target image's Write block: `1`–`10` then
`… +181 lines`. Tabs become spaces so the gutter stays aligned. Rewriting an
existing file currently uses the same preview (open item 3).

## 7. The command view

For `bash` and `powershell` the command *is* the header — that is the "see what
is running" requirement, satisfied without expansion. The body is the last
**5 lines** of what the command printed, like a terminal tail, with
`… N earlier lines` when there was more above. No output means no body. Long
commands are clipped in the header.

## 8. What explicitly does not change

- Assistant prose (white `●`), the thinking/reasoning block, and the error
  notice behaviour.
- The user message bar, the header, the footer, the sidebar and the task panel.
- The `fetch` row tree and the compact skill rows — both already have the
  header/branch shape this design is copying.
- Ctrl+O and click-to-expand still reveal the complete native output behind any
  preview. The preview is the default view; expansion becomes the exception.
- **What the model sees and what is stored in the session are untouched.** This
  is presentation only. No tool behaviour, no retries, no credentials, no
  prompts change.

## 9. Edge cases worth deciding on

- A failed call: one line, `└ failed · <message>` in the error colour, no body.
- A stopped run: `└ interrupted` on every call that had not settled.
- A very long diff: capped at 12 printed lines (§5).
- A command with no output: no body line.
- A binary or image result: a one-word branch line, no body.
- A very narrow terminal: drop the line-number gutter first, then clip the
  branch text; the header and branch must always survive.
- Control characters or non-UTF bytes in a path, command or output: stripped, as
  the existing rows already do.
- Many calls in one run (say twenty reads): one block each. This is the known
  cost of the design — it is more rows than the old one-line summary (open
  item 7).

## 10. How this ships

The hiding happens inside pi's own transcript code, so this is delivered as a
change to the maintained pi-core patch (the three presentation modules the
project already patches), not as an ordinary extension. Practically that means:
the change lands in `patches/runtime/tool-group.ts` with offline tests; the
whole test suite must pass; then the patch is applied to the installed pi with
pi closed, and pi is restarted. A future pi upgrade needs the patch re-audited
against the new version and re-applied. The patch is audited for pi 0.86.0 only.

## 11. Open items — the decisions I need from you

1. **Running colour.** While a call is in flight, should its `●` and tool name
   turn the existing violet, or stay accent with only the branch text showing
   state? *(Recommendation: stay accent; keep all colour meaning on the branch
   text, so blocks do not flicker colour.)*
2. **Duration on shell branches.** `exit 0 · 1.2s` needs the group to time the
   call itself (approximate), because pi keeps its timer private to the native
   renderer. Include it, or keep the branch to `exit 0`?
3. **Rewriting an existing file.** `write` over a file that already exists could
   show a diff instead of a content preview. Keep the content preview for all
   writes *(recommended)*, or diff the rewrite?
4. **Word-level highlight inside bands.** Keep it *(recommended — it is what
   makes a one-line edit readable)* or use plain solid bands?
5. **Budgets.** Confirm 4 context lines, 12-line diff cap, 10-line write
   preview, 5-line command tail.
6. **Blank line between blocks.** Keep it *(recommended — it is the calm)* or
   drop it to save rows?
7. **Very long runs.** Keep one block per call *(recommended)*, or fall back to
   today's one-line summary once a run passes some number of calls?
8. **Light theme.** Accept fixed dark bands, since the product targets the dark
   remoticon theme *(recommended)*, or budget for a light variant later?
