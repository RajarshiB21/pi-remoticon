# Research extension port — design

Status: agreed design record — 2026-09-13. Implementation proceeds from this document.

## 1. Purpose

Move the web-research capability from the discarded harness into pi-remoticon so the agent can fetch public pages through a Scrapling escalation ladder and see the result painted in the remoticon transcript.

pi-remoticon is already a package in the global pi settings (`D:\Workspace\01_Active\pi-remoticon`), and its manifest already loads `./extensions`. This port therefore adds nothing to `C:\Users\rajar\.pi\agent`: no settings entry, no `APPEND_SYSTEM.md`, no file copy. Dropping the extension into the package is the whole install.

## 2. Source of truth

These nine files are the complete salvage source and the only permitted reads from that tree, verified present 2026-09-13 (read-only reference, do not modify; nothing else in that tree is part of the port):

- `E:\PORT\Workspace\FAILED_DISCARDED\.pi\agent\extensions\research\index.ts`
- `E:\PORT\Workspace\FAILED_DISCARDED\.pi\agent\src\research\index.ts`
- `E:\PORT\Workspace\FAILED_DISCARDED\.pi\agent\src\research\helper.py` (912 lines)
- `E:\PORT\Workspace\FAILED_DISCARDED\.pi\agent\src\research\tool.ts`
- `E:\PORT\Workspace\FAILED_DISCARDED\.pi\agent\src\research\process.ts`
- `E:\PORT\Workspace\FAILED_DISCARDED\.pi\agent\src\research\protocol.ts`
- `E:\PORT\Workspace\FAILED_DISCARDED\.pi\agent\src\research\result.ts`
- `E:\PORT\Workspace\FAILED_DISCARDED\.pi\agent\src\research\validate.ts`
- `E:\PORT\Workspace\FAILED_DISCARDED\.pi\agent\src\research\render.ts`

Verified environment (2026-09-13):

- pi `0.85.1` at `C:\Users\rajar\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent`; core patch currently applied (`UI_HASH 5959d79…`, manifest phase `applied`).
- Scrapling `0.4.15`, Python 3.12, orjson 3.12, curl_cffi, Playwright 1.62 in `C:\Users\rajar\miniconda3\envs\scrapling`.
- Workflow authority: `https://github.com/RajarshiB21/Remoticon/blob/main/AGENTS.md` — the workspace repo (56 files, latest commit `a45dee0`, PR #7 "workflow-repair"). Its delivery sequence, review limits and approval boundaries govern this port; §10 maps them.
- Tests: this port extends pi-remoticon's own `test/` suite; the fetch source carries no tests.

## 3. Locked decisions

| # | Decision | Choice | Consequence |
|---|---|---|---|
| D1 | Loading | New package extension; global settings untouched | No `C:` writes; live on next pi start |
| D2 | Prompt layer | All old bullets as `promptGuidelines` (A1) | ~17 bullets ride in every session's Guidelines section, exactly the tuned surface |
| D3 | Row shape | `●` state marker + `└` branches (B) | Matches the skill invocation rows already in the transcript |
| D4 | Expanded body | Per-target rows + throttle evidence; **no attempt chronology** (C) | TUI only; `result.ts` model text still carries the ladder line |
| D5 | Collapsed line | Extension-supplied `details.groupSummary`; generic patch rule | No fetch-specific logic or name in the patched runtime |
| D6 | Interpreter | `PI_REMOTICON_PYTHON`, else `python`/`python3` on PATH | No machine-absolute path anywhere (preflight rule) |
| D7 | Scope | Full parity with the discarded helper | Ladder, `blockedDomains`, `captureXhr`, remote CDP, known-hard domains, receipts |
| D8 | Behavior fix | One-line `emitter` order fix in `helper.py` | Invalid `outputDir` reports the real reason instead of `NameError` |
| D9 | Live verification | Performed by the user with real models | CI stays offline and credential-free |
| D10 | Spec home | `docs/superpowers/specs/2026-09-13-research-port-design.md` | New `docs/` dir in pi-remoticon |

## 4. Architecture

### 4.1 Files

| Old | New | Change |
|---|---|---|
| `extensions/research/index.ts` + `src/research/index.ts` | `extensions/research.ts` | Folded into one factory; the only new file in `extensions/` (every file there must be a valid factory — `test/package-load.integration.test.ts` enforces it) |
| `src/research/tool.ts` | `lib/research/tool.ts` | `.js` import suffixes; schema + guidelines verbatim |
| `src/research/process.ts` | `lib/research/process.ts` | `.js` suffixes; interpreter resolution replaces the hardcoded const |
| `src/research/protocol.ts` | `lib/research/protocol.ts` | Verbatim |
| `src/research/validate.ts` | `lib/research/validate.ts` | Verbatim |
| `src/research/result.ts` | `lib/research/result.ts` | Verbatim |
| `src/research/render.ts` | `lib/research/row.ts` | Rewritten against remoticon primitives (§6) |
| `src/research/helper.py` | `lib/research/helper.py` | Verbatim + D8 fix |
| — | `lib/research/requirements.txt` | New: `scrapling==0.4.15`, `orjson` |
| `patches/runtime/tool-group.ts` | same | Custom-summary rule (§7) |
| `scripts/core-patch-plan.ts` | same | New `UI_HASH`; old hash stays accepted |
| — | `test/research-*.test.ts` | New offline tests (§9) |

`tsconfig.json` already includes `extensions/**`, `lib/**`, `test/**`. `package.json` gains no dependency (pi provides the core packages, typebox included; the helper's dependencies are Python). No config change.

Entry point:

```ts
// extensions/research.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activateResearchTools, registerFetchTool } from "../lib/research/tool.js";

export default function research(pi: ExtensionAPI): void {
  registerFetchTool(pi);
  pi.on("session_start", () => activateResearchTools(pi));
}
```

The old `src/research/index.ts` wiring is folded in: `registerFetchTool` and `activateResearchTools` both live in `lib/research/tool.ts`; the entry only wires them.

### 4.2 Data flow (unchanged from the verified design)

`fetch` tool call → TS validation (no spawn on rejection) → one versioned `HelperRequest` JSON on stdin to `helper.py` under the Scrapling interpreter → NDJSON on stdout (`batch_started`, `attempt_finished`, `target_finished`, `batch_finished`, `fatal_error`) → `result.ts` assembles the model-visible text, `row.ts` paints the transcript, `details` carries the receipt. stderr is log-only and capped; any malformed stdout line kills the process tree; 40 s wall clock; cancellation kills the tree and settles once. The `spawnForTest` hook in `runHelper` is kept — it is the seam the process tests use.

### 4.3 Tool contract

Name `fetch` (no built-in conflict). Parameters exactly as the old tool: `targets` (1–8 × `{url, selector?}`), `blockedDomains` (≤32 bare domains), `captureXhr` (validated pattern). `renderShell: "self"`. `promptSnippet`, `promptGuidelines`, `description` copied verbatim (D2). `execute` keeps the old behavior: duplicate-URL rejection, `mkdtemp` output dir, `onUpdate` pending rows, `allTargetsFailed` throw, temp-dir cleanup on shutdown and when nothing was handed to the model.

## 5. Port details

- **`protocol.ts`** — `PROTOCOL_VERSION = 3`; `parseHelperEvent` strictness unchanged (unknown type, version mismatch, missing/incorrect `batchId`, non-JSON line all fail the call). `pageLadder` kept; `result.ts` uses it for the model text.
- **`process.ts`** — `DEFAULT_HELPER_DEADLINE_MS = 40_000`, stderr capture 16 KiB, tail shown 600 chars, `taskkill /T /F` then `child.kill()`, `HelperCancelledError` / `HelperDeadlineError` semantics unchanged. `helperScriptPath()` stays `join(dirname(fileURLToPath(import.meta.url)), "helper.py")` and resolves next to the module. Interpreter resolution per D6:

  ```ts
  function resolveHelperInterpreter(): string {
    const configured = process.env.PI_REMOTICON_PYTHON?.trim();
    if (configured) return configured;
    return process.platform === "win32" ? "python" : "python3";
  }
  ```

  A spawn failure (`ENOENT`) or a helper import failure surfaces as a tool error naming `PI_REMOTICON_PYTHON` and the `scrapling==0.4.15` requirement. No absolute path is embedded anywhere.

- **`validate.ts`** — verbatim; the documented `PI_RESEARCH_TEST_ALLOW_LOOPBACK=1` test gate is kept as-is (the tool never sets it).
- **`result.ts`** — verbatim; model text keeps every fact including the ladder line (`recovered: first 403 (http) -> final 200 (stealth)`), per-target truncation notices, and the 16 KiB/50 KiB/2 000-line bounds.
- **`helper.py`** — verbatim except the D8 fix: move `emitter = Emitter(batch_id)` above the `outputDir` validation at the top of `main()`. The extended block set, RV-9 known-hard-domain fast path, browser kwargs, `PI_RESEARCH_CDP_URL` redaction, and receipts are unchanged.
- **`tool.ts`** — rename imported module paths only; add the summary computation used by D5 in `lib/research/summary.ts` (a small pure function over the current pages/attempts, unit-tested) and set `details.groupSummary` from it on every update.

## 6. UI specification

Approved visual contract: the 2026-09-13 session mockups at `.superpowers/brainstorm/234-1789240898/content/fetch-row.html` (row shape B) and `.superpowers/brainstorm/234-1789240898/content/fetch-body.html` (body C). Columns follow the old layout and native row convention: marker at column 0, branch glyph at column 2, branch content at column 4. Rows paint no background (`renderShell: "self"`; the theme's tool background tokens are `""` by design).

### 6.1 Collapsed group line (D5)

The extension carries one plain-text string in `details.groupSummary` on every update:

- running: `Fetching N page(s)…`
- settled: `Fetched N page(s)` + ` · M dead end(s)` when M > 0 + ` · K failed` when K > 0
- cancelled: `Fetch cancelled`

The string is plain text (no ANSI, no control characters) and is recomputed on every `onUpdate`, so the group line follows the batch from start to settle. When every target fails at transport level the tool throws (existing behaviour) and the group shows its generic failure line plus the error text; no custom summary is involved in that path.

### 6.2 Expanded body

Call line:

```
● Fetch(en.wikipedia.org/wiki/Scrapling)
● Fetch(3 URLs concurrently)
```

Multi-target counts use the number of targets. URLs use the old `shrinkUrl` behavior (scheme stripped, middle-ellipsized).

Per-target rows (`└` dim glyph, target accent):

| State | Line |
|---|---|
| usable | `200 OK · 84.2KB received · main content → 42.1KB` |
| usable + selector | `200 OK · 84.2KB received · selector "main" → 6.1KB` |
| recovered | `403 → cleared with stealth · 200 OK` |
| recovered from empty | `200 → empty → cleared with stealth · 200 OK` |
| recovered from transport failure | `failed → cleared with stealth · 200 OK` |
| dead end | `404 → not found` |
| hard block | `403 → blocked after 3 attempts, including stealth` |
| transport failure | `failed: <real error>` |
| redirect | requested row gains ` (final <url>)` when it differs |

Evidence lines under their target, dim:

- `[truncated for the model: kept 16.0KB of 42.1KB; full sanitized markdown saved to <path>]`
- `captured xhr (K responses):` then one line per entry label: `[<url>] (<status>, <bytes>)`, marked `truncated` where it applies. The TUI shows labels only; the captured content stays in `details` and in the model text.

One throttle line at the end, omitted when there are no observed delays:

```
AutoThrottle on (start 250ms, max 30000ms, block backoff on) · observed: www.reddit.com 1200ms
```

While running, per-target rows come from `details.live` and read `attempt N (tier): <status | request failed>`; the `●` is violet. No attempt chronology is rendered (D4); the full attempt records stay in `details` and in the model text.

### 6.3 Colour map

| Element | Token / value |
|---|---|
| `●` running | violet `#b9a5e8` (same literal the group uses for pending) |
| `●` settled | `success` `#9fcbb4` |
| `●` failed / cancelled | `error` `#e89891` |
| `└` glyphs, truncation/captured-XHR labels | `dim` `#92949e` |
| targets / URLs | `accent` `#8abeb7` |
| success facts (`200 OK`, recovered) | `success` `#9fcbb4` |
| block / dead end | `warning` `#ffff00` |
| transport failure | `error` `#e89891` |
| sizes, meta, throttle line | `muted` `#a4a5ae` |

## 7. Patch delivery (D5)

`patches/runtime/tool-group.ts` gains one generic rule, no fetch knowledge:

1. Widen the row result details type with `groupSummary?: string`.
2. In `snapshot()`, read `row.result?.details?.groupSummary` when it is a non-empty string and carry it on the snapshot. This works while pending because partial results carry `details` (`ToolComponent.updateResult` stores them with `isPartial`).
3. In the segment summary builder, an entry with a custom summary contributes that string as its own part and skips the counting buckets; other entries keep the current behaviour. Parts join with ` · `.
4. Existing state flags (`failed`, `pending`, `stopped`) still run for every entry, so colour and the `! error` line are unchanged.
5. Fallback: no details (first frame before the first update) → the existing generic `1 fetch call pending` / `completed`.
6. Stopped edge: when every part is a custom summary, omit the `Stopped ` prefix (the summary already names the state); mixed segments keep the prefix.

`scripts/core-patch-plan.ts`: recompute and record the new `UI_HASH`; add it to the accepted patched-hash list in `validateManifest` and to the managed-hash list in `inspectPlan`, keeping the current hash so the installed patch is a supported previous state. `PATCHES` remains 5 entries; the runtime patch flows through `runtimePatches()`.

Apply workflow on this machine after implementation: close pi → `npm run core-patch -- apply --target "%APPDATA%\npm\node_modules\@earendil-works\pi-coding-agent"` → the script reports `older managed`, rebuilds from verified original bytes, records the previous fingerprint → reopen pi. `restore` is unchanged. A pi upgrade still requires a fresh audit (0.85.1 pinned).

## 8. Python environment

- `lib/research/requirements.txt`: `scrapling==0.4.15`, `orjson`.
- README prerequisites block: create/point at a conda env with those, `playwright install chromium`, and export `PI_REMOTICON_PYTHON` to that interpreter. The known-good path on this machine is `C:\Users\rajar\miniconda3\envs\scrapling\python.exe`; it appears only in the README, never in code.
- The helper's internal API usage (`_retry_count`, `_session_kwargs`, `engine._autothrottle`) is version-sensitive; the pin is the guard.

## 9. Testing plan

Three lanes, as the repo actually runs today:

- **Local (Windows)** — the dev loop. `npm ci`, `npm run test:setup` (node-pty repair), then `npm run typecheck`, `npm run lint`, `npm test`. The full suite is green here before pushing.
- **GitHub Actions CI** — the authoritative Linux gate. A fresh isolated `ubuntu-latest` machine per push/PR runs `.github/workflows/ci.yml` (typecheck, lint, unit + integration under the 2-minute step cap, no Python and no network). Measured headroom on the last green `main` run (2026-09-09): the unit+integration step took 57 s of its 120 s cap, the whole job 1m26s. Work lands through PRs (#5–#10 merged); CI is the gate, not local-only pushing.
- **CodeRabbit** — automated PR review (confirmed active on PR #10). Advisory: it comments, it does not gate CI, and its findings are addressed in the PR like any review.

Rules for this port's tests: offline, no credentials, and small enough to fit the CI headroom.

1. **Static** — existing typecheck/lint; `test/preflight.test.ts` keeps `lib/research/process.ts` free of machine-absolute paths.
2. **Unit** —
   - `research-protocol.test.ts`: strict NDJSON cases.
   - `research-validate.test.ts`: target URLs, `blockedDomains`, `captureXhr`.
   - `research-result.test.ts`: counts, ladder line, truncation notices, global bound.
   - `research-summary.test.ts`: pending/settled/cancelled strings, singular/plural, dead-end/failed parts.
   - `research-row.test.ts`: real `ToolExecutionComponent` with synthetic details; B-shape text at widths 120/80/40/20/1; no background painted.
   - `tool-groups.test.ts` (extend): custom summary pending → settled; multiple custom entries joined; fallback when details are missing; stopped edge; other tools unchanged.
3. **Process** — `research-process.test.ts` through `spawnForTest`: happy batch, `fatal_error`, malformed stdout, deadline, cancellation.
4. **Integration** — new `test/research-integration.test.ts`: add a `FETCHBAD` token to `test/fixtures/fake-provider.ts` emitting a `fetch` call with `ftp://example.com/file` (scheme rejected before any spawn: proves registration in the real package boot, schema, validation, error row and group line). No Python, no network, no absolute paths in the fixture (preflight-scanned). `package-load.integration.test.ts` continues to guard the factory-only rule and now loads the new extension.
5. **Patch** — `apply-core-patch.test.ts` re-derives the patched copy from audited 0.85.1 bytes with the new `UI_HASH`; `package-load.integration.test.ts` boots the patched copy.
6. **Not in CI** — real fetch, Python, browsers, models. D9.

## 10. Workflow compliance (Remoticon AGENTS.md)

Authority: `https://github.com/RajarshiB21/Remoticon/blob/main/AGENTS.md`. It owns the delivery sequence. Reading it is permitted and expected in the implementation session; the nine steps below are its operative projection onto this port. This spec is the agreed change record.

Before implementation (AGENTS.md requires all six records):

- **Relevant code inspected** — the port source and the pi-remoticon harness, this session.
- **Uncertain mechanisms, each settled by the smallest safe local check before it is relied on**:
  1. `import.meta.url` resolves `lib/research/helper.py` under pi's loader — one boot check.
  2. Partial `details.groupSummary` reaches the patched group while a row is still running — one row test plus one boot check.
  3. `PI_REMOTICON_PYTHON` resolution and the helper's Scrapling imports — one direct interpreter invocation (imports verified 2026-09-13).
- **Files to change** — §4.1.
- **Required checks** — §9 lanes.
- **Permitted agents** — `scout-master` for delegated exploration if needed; `reviewer-general` and `reviewer-code-quality` for step 5; no other workers.
- **First observable result** — pi boots on the branch with `fetch` registered and the invalid-target error row painted in an expanded group (the offline `FETCHBAD` path).

Delivery sequence for this port:

1. This spec is the agreed change record.
2. Work happens on a branch in `pi-remoticon`; all product edits live there.
3. UI: the approved mockups are the visual contract. The first working increment is inspected in native `tuiMode: fullscreen`, run by the user, who records what was observed. Automated assertions do not prove appearance.
4. The implementer inspects the complete diff and runs local typecheck, lint, unit and integration checks; commits the coherent candidate before review.
5. `reviewer-general` and `reviewer-code-quality` (the workspace authority's read-only reviewers, not pi tools in this repo) run once each on the recorded base and candidate commits, with intended uncommitted files listed explicitly. Fix demonstrated findings, run affected checks, commit corrections, then give each affected reviewer its original report, dispositions, correction diff and check evidence for one verification callback. No further rounds without the user's word.
6. The user verifies user-visible changes by running pi on the branch and records the approved commit and installed patch revision. Only then is the branch pushed and a PR opened.
7. Wait for GitHub CI and CodeRabbit on the latest pushed revision. Read both; retrieve every inline comment (`gh api --paginate repos/<owner>/<repo>/pulls/<n>/comments`); disposition every finding with evidence; fix demonstrated defects; collect optional items for one user decision; reply to and resolve addressed threads; the latest check stays green. Remote fixes get implementer inspection and affected checks, then fresh reports. Do not restart local reviewers after CodeRabbit. Changed visuals need renewed visual approval.
8. The user merges. The implementer never does.
9. Pull `main` down afterwards and verify the installed patch revision matches the approved source.

User smoke run (step 6): fetch an ordinary page (collapsed line → expand → per-target row), a Reddit HTML page (ladder recovery painted), a 404 URL (dead end painted). Live model behaviour is the user's call (D9).

## 11. Risks

- **pi upgrade** invalidates the patch (existing, unchanged); 0.85.1 pin is the guard.
- **Scrapling upgrade** may move the internal APIs the helper uses; requirements pin is the guard.
- **First-frame transient**: before the first `onUpdate`, the collapsed line shows the generic `1 fetch call pending`.
- **CI budget**: the unit+integration step had 57 s of its 120 s cap on the last `main` run; all new tests stay offline, and the added boot work must fit the remaining headroom (one extra PTY boot ≈ 15–30 s).
- **Stale README**: the repo README still says "Local git only. No cloud pipeline, no pull requests", which contradicts the current PR + GitHub CI + CodeRabbit flow; update it during implementation.
- **`.superpowers/`** (brainstorm mockups) is currently untracked; add it to `.gitignore` during implementation.

## 12. Non-goals

No web search, no subagent work, no `APPEND_SYSTEM.md`, no skill-based prompt content, no global settings edits, no attempt chronology in the TUI (D4), no rewriting of helper fetch logic, no ui-design changes outside the fetch row.

## 13. Definition of done

- Both `extensions/research.ts` and `lib/research/*` exist, load through the package manifest, and `npm test` is green offline.
- The installed pi shows the new `●`/`└` fetch row and the patch-aware collapsed line after `core-patch apply`.
- `C:\Users\rajar\.pi\agent` gained no file; the only config change is the env var in the user's shell.
- The model text still carries ladder/truncation evidence.
- The §10 delivery sequence is followed through the user's merge and the post-merge pull, with the installed patch revision matching the approved source.

What makes it fail: a helper module in `extensions/`, a fetch-specific branch in the patched runtime, an absolute interpreter path, a `groupSummary` that the patch only reads on settle, or a test that reaches the network.
