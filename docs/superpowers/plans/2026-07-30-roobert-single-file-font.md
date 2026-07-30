# Roobert Single-File Variable Font Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Progress is tracked in Linear, not only in this file.** Read **Section D** before Task 0 and follow it for every task. The checkboxes here are your local working state; Linear is what Jay reads. If the two disagree, Linear is wrong and you did not update it.

**Goal:** Replace `apps/web`'s four Roobert `.woff2` files (528 KB, up to 4 requests) with the foundry's single three-axis `RoobertCollectionVF.woff2` (300 KB, 1 request), fix the live monospace-alignment bug, and expose a ten-step weight ladder plus a SemiMono family.

**Architecture:** One `.woff2` binary is referenced by four hand-authored `@font-face` rules in `globals.css`. Each rule pins its axes with the `font-variation-settings` **descriptor** (`MONO` 0/60/100, `ital` 0/11) while leaving `wght` free to `font-weight`. Because all four rules share one `src`, the browser downloads the file once. `next/font/local` is removed — it fingerprints per call and would emit the same binary four times (~1.2 MB, worse than today).

**Tech Stack:** Next.js 15 App Router, Tailwind CSS v4 (`@theme inline`), CSS `@font-face` variation descriptors, Playwright (Chromium + Firefox + WebKit).

**Source spec:** `docs/superpowers/specs/2026-07-30-roobert-single-file-design.md` — read it first. It carries findings F1–F8 and design D1–D6. This plan implements that spec **with three corrections proven in Section B below.**

---

## Global Constraints

- **Scope is `apps/web` only.** `apps/mobile` is explicitly deferred (spec "Out of scope"). Do not touch `apps/mobile`.
- **The font licence forbids modification.** `name[13]`: *"you should not modify, reassemble, rename, store on publicly accessible servers, redistribute, or sell them."* Vendor `DP`, Displaay Type Foundry s.r.o. Never subset, merge, re-generate, or rename the binary. Copy it byte-for-byte.
- `**wght` axis is `300–900`.** Not `100–900`. Weights 100, 200 and 950 do not physically exist. Never declare `font-weight: 100 900` again.
- `**ital` axis is `0–11`, not `0–1`.** CSS `font-style: italic` alone yields ~9% of the intended slant. Italic faces must pin `'ital' 11`.
- `**MONO=60` (SemiMono) is NOT monospaced.** Verified: `WWWWWWWWWW` 371.72px vs `mmmmmmmmmm` 350.80px. Never use `font-semimono` for code, diffs, or column-aligned tables.
- **Do not use `next/font/local` for these faces.** Per-call fingerprinting duplicates the binary.
- **Never commit a plaintext secret.** No task here touches secrets, but the repo-wide rule stands.
- **Every task ends with the real command run and its real output pasted.** No "should work".
- **Do not commit unless explicitly asked.** Each task below has a commit step; run it only when the operator confirms.
- **Every task is mirrored by a Linear issue in the `Jay` team.** Move it to `In Progress` before the first step and to `Done` only after that task's verification output is pasted into a Linear comment. Never mark an issue `Done` on the strength of a passing checkbox alone. See Section D.

---

## Section A — Environment preconditions

`/Users/jay/root/kortix/suna-font` (branch `font`) already exists as a worktree. **Do not create a new one.** Verified state:

- Working tree clean except `apps/web/src/lib/seo/content-timestamps.json` (pre-existing, unrelated — do not commit) and the untracked spec + this plan.
- The `globals.css` shadow-ladder conflict the handoff warned about is **not present in this worktree**. `globals.css` is clean here.
- `node_modules` installed at root and `apps/web`.

Two real blockers to clear before running the app:

- [ ] **A1: Copy the gitignored dotenvx keys.** Without `apps/web/.env.keys`, middleware returns 500.

```bash
cp /Users/jay/root/kortix/suna/apps/web/.env.keys /Users/jay/root/kortix/suna-font/apps/web/.env.keys
cp /Users/jay/root/kortix/suna/apps/api/.env.keys /Users/jay/root/kortix/suna-font/apps/api/.env.keys
ls -la /Users/jay/root/kortix/suna-font/apps/web/.env.keys
```

- [ ] **A2: Install Firefox and WebKit.** Only `chromium-1228` is present in `~/Library/Caches/ms-playwright`. Task 1 cannot run without these.

```bash
cd /Users/jay/root/kortix/suna-font/apps/web && pnpm exec playwright install firefox webkit
ls ~/Library/Caches/ms-playwright
```

Expected: directories matching `firefox-*` and `webkit-*` now exist.

- [ ] **A2b: Install the `tests/` package's own dependencies.** `tests/` (`@kortix/tests`) is **not** a member of the root `pnpm-workspace.yaml` — only `tests/e2e` is. It carries its own `tests/bun.lock`, and `tests/node_modules` may not exist in a fresh worktree. Without this, every Playwright command fails with `sh: playwright: command not found`. This bit the Task 1 implementer twice.

```bash
cd /Users/jay/root/kortix/suna-font/tests && bun install
cd /Users/jay/root/kortix/suna-font/tests && pnpm exec playwright --version
```

Scoped to that package's existing lockfile — do **not** run a root `pnpm install`. `tests/node_modules` is gitignored, so there is no lockfile or dependency diff to commit.

- [ ] **A3: Run this worktree's web app on port 3100. NOT 3000.**

**Verified 2026-07-30: ports 3000 and 8008 are owned by the primary checkout**
`/Users/jay/root/kortix/suna` (pids 68604 `next-server`, 34345 `bun run --hot`).
Pointing `E2E_BASE_URL` at `localhost:3000` would verify the **primary checkout, which
has none of these font changes** — every assertion would be measuring the wrong code.
**Do not kill those processes**; they are someone else's running stack.

This worktree uses **3100**. Only the Next.js app is needed: `/design-system` is a public
marketing route, so no API, Supabase or tunnel is required for any font assertion.

```bash
cd /Users/jay/root/kortix/suna-font/apps/web && WEB_PORT=3100 pnpm dev
```

`pnpm dev` at the repo root would start the whole stack and fight the primary for ports —
don't. If Node 26 is the default, `nvm use 22` first.

**Then prove you are talking to this worktree, not the primary.** A font test against the
wrong server is the most expensive false result available here:

```bash
curl -s http://127.0.0.1:3100/design-system -o /dev/null -w "worktree app: %{http_code}\n"
lsof -a -p "$(lsof -tiTCP:3100 -sTCP:LISTEN | head -1)" -d cwd -Fn | grep '^n' | cut -c2-
```

Expected: `200`, and a cwd of `/Users/jay/root/kortix/suna-font/apps/web`. If the cwd
says `/Users/jay/root/kortix/suna`, you are on the primary — stop and fix the port.

Every Playwright command in Tasks 3–6 therefore uses:

```bash
export E2E_BASE_URL=http://127.0.0.1:3100
```

Next.js compiles routes on first hit; the first navigation to a cold route can take
30–60s. Warm it with the `curl` above before running timed assertions.

---

## Section B — Corrections to the spec (verified this session)

The spec's design is sound with three exceptions. All three were measured in Chromium against the real binary. Reproduce with the scripts noted; do not take these on faith if you change the approach.

### C1 — `@font-face` `font-feature-settings` is overridden by inheritance. D4/D5 must move to element level.

`globals.css:731` (`html`) and `globals.css:750` (`body`) set `font-feature-settings: 'ss10' on, 'ss09' on, 'ss03' on, 'ss04' on, 'ss14' on, 'palt'` at **element** level. That declaration inherits into every descendant, including `code` and `pre`, and it **beats the `@font-face` descriptor.**

Measured — one span inheriting the `html` sets vs one with `font-feature-settings: normal`, while the `@font-face` descriptor said `normal` for both:

```
a (inherits) featureSettings="palt","ss03","ss04","ss09","ss10","ss14"  width=278.41
b (reset)    featureSettings=normal                                     width=282.25
pixels identical : false
```

The descriptor lost. **Consequences:**

1. Today's `declarations: [{ prop: 'font-feature-settings', ... }]` in `roobert-mono.ts` is already **dead code** for elements — `globals.css` has been winning all along.
2. Spec D4 ("remove `ss03/ss04/ss09/ss10/ss14` from the mono family entirely") **cannot** be implemented by editing `@font-face`. It must be an element-level declaration on the `code, pre, .font-mono` rule at `globals.css:779`.
3. `font-variant-ligatures` has **no** `@font-face` descriptor at all, so the F3 fix is element-level regardless.

### C2 — The proposed D4 block does work, and `calt off` alone does not.

D4 pairs `font-variant-ligatures: none` with `font-feature-settings: "zero"`. Those two properties interact, so it was worth checking that `"zero"` does not re-enable ligatures. It does not. Five 17-character lines at 32px, family pinned `MONO=100`:

```
current (prod)   [ 282.3  322.5  282.3  342.7  342.7]  spread= 60.4px  RAGGED
D4 verbatim      [ 342.7  342.7  342.7  342.7  342.7]  spread=    0px  FLUSH
lig-none only    [ 342.7  342.7  342.7  342.7  342.7]  spread=    0px  FLUSH
calt off only    [ 302.4  322.5  282.3  342.7  342.7]  spread= 60.4px  RAGGED
```

D4's declaration block is correct as written. F3's claim that `calt off` is insufficient is confirmed.

### C3 — Tailwind has no `font-950` utility. The tenth step needs a name.

Spec D3 lists `950` as the tenth weight. Tailwind v4's `--font-weight-*` namespace ships nine names (`thin` … `black`); there is no `950`. To deliver Jay's ten distinct steps, the tenth needs a new token.

**Recommendation: `font-heavy` → `wght 900`.** Roobert's own named instance at 900 is literally "Heavy", so the name matches the typeface's vocabulary rather than inventing one. Ladder verified 10/10 distinct at 48px:

```
300 -> 490.72   335 -> 491.58   368 -> 492.39   400 -> 493.19   500 -> 495.66
600 -> 499.48   700 -> 502.05   800 -> 503.97   870 -> 505.31   900 -> 505.88
distinct widths: 10/10
```

**This is the one open decision in this plan.** Confirm `font-heavy` with Jay before Task 4, or substitute a preferred name. Everything else is settled.

### C4 — WebKit ignores the `@font-face` descriptor. **D2 is replaced.** (spec R3, materialized)

Task 1's gate found it. Measured on chromium 149.0.7827.55, firefox 151.0, webkit 26.5
(playwright `webkit-2311`), with an independent counting HTTP server:

| Engine | Real binary fetches | `@font-face` descriptor | Element-level `font-variation-settings` |
| --- | --- | --- | --- |
| Chromium | 1 | pins ✅ 493.19 / 604.72 / 560.95 | pins ✅ identical |
| Firefox | 1 | pins ✅ 493.28 / 604.58 / 560.88 | pins ✅ identical |
| WebKit | 1 | **IGNORED ❌** — all three families render 493.18 | pins ✅ 493.18 / 604.70 / 560.95 |

In WebKit, `MONO=100` gives `W` 475.68 vs `m` 423.36 — **not monospaced**. Under the
original D2, Safari would render all code in a proportional face. No `src` syntax
rescues it: `format('woff2')`, `format('woff2-variations')`,
`format('woff2 supports variations')` and a bare `url()` are all ignored.

**Firefox is not a failure.** It emits 4 `request` events but the server logs **1**
fetch — three are cache hits. The one-download goal holds. Any test asserting on
`page.on('request')` counts measures the wrong thing and must count real fetches.

**The replacement design — one family, axes as custom properties.** Jay approved it on
2026-07-30. Verified in all three engines:

```css
@font-face {
  font-family: 'Roobert';
  font-weight: 300 900;
  font-display: swap;
  src: url('/fonts/roobert/RoobertCollectionVF.woff2') format('woff2');
}
:root { --rb-mono: 0; --rb-ital: 0; }
/* Declared on `*` deliberately: font-variation-settings is inherited, so a
   descendant that only changes --rb-mono would otherwise inherit the parent's
   already-substituted value and never re-resolve. `*` makes every element
   compute its own from the custom properties, which DO inherit. */
* { font-variation-settings: 'MONO' var(--rb-mono, 0), 'ital' var(--rb-ital, 0); }
code, pre, .font-mono { --rb-mono: 100; }
.font-semimono { --rb-mono: 60; }
em, i, .italic { --rb-ital: 11; }
```

Verified 3/3 engines: axes distinct; mono truly monospaced (302.4 == 302.4); SemiMono
proportional (371.7 vs 350.8); italic differs; `mono` + `italic` composes to
`"MONO" 100, "ital" 11`; `font-weight` still free across 300–900; five 17-character
lines flush within 0.07px.

**Consequences for the rest of this plan:**

- There is **one** CSS family, `Roobert`. `Roobert Mono` and `Roobert SemiMono` no
  longer exist as families. Nothing in the codebase referenced them by name.
- `--font-mono` / `--font-semimono` remain as tokens so `font-mono` / `font-semimono`
  utilities keep working, but they resolve to the same family. Mono-ness comes from
  `--rb-mono`, not from the family name.
- Two `@font-face` rules split by `font-style` are no longer used; italic is `--rb-ital: 11`.
- **`kortix-letter-field.cells.ts:133` needs no change, and here is why** — an earlier
  read of this plan claimed it did. It builds `font-family="var(--font-mono), …"` into an
  SVG string that `svgToDataUri` encodes into a `data:image/svg+xml` **`background-image`**
  (`kortix-letter-field.tsx:83-85`). A `data:` URI SVG renders as an isolated document, so
  the host page's custom properties are not available to it: `var(--font-mono)` has never
  resolved there and the component already falls back to `ui-monospace`. It renders in
  system mono today and will render in system mono after this change — zero visual delta.
  Making it use Roobert would need an SVG presentation attribute
  (`font-variation-settings="'MONO' 100"`) and is a **visual change to a marketing
  surface**, therefore out of scope here. Track as a follow-up; do not fix it in this plan.

### Also verified (no correction needed)
- **Pinning `MONO` in the descriptor does not lock `wght`.** The sans ladder gives 10 distinct widths, and Roobert Mono at wght 300/400/700/900 differs pixel-wise at every step (widths are identical there only because monospace advance is fixed by design — width is the wrong metric for that face).
- **F7 reconfirmed.** SemiMono `W` 371.72 vs `m` 350.80 — proportional, not monospaced.
- **Cache headers need no change.** `next.config.ts:313` already sets `public, max-age=31536000, immutable` on `/fonts/:path`*.

### Risk register updates

- **R5 is nearly a non-risk.** Only `300` and `900` shift. Audited `apps/web/src`: `font-thin` 0 files, `font-black` 0 files, `font-extralight` 1 file (`apps/web/src/app/(app)/invites/[inviteId]/page.tsx`), `font-light` 2 files (`apps/web/src/components/blog/blog-cover.tsx`, `apps/web/src/components/use-cases/covers.tsx`). Three files to eyeball, not a sweep.
- **R6 — visual baselines: WITHDRAWN, see C7.** Originally flagged as "this change moves the landing snapshots, so Task 6 refreshes them". Measurement showed the baselines are already ~26% stale against `main` itself, the full-page one has a 1280px height error present on `main` too, and no workflow gating PRs to `main` runs `test:visual` (the two that do run it target `prod`/`staging` on `ubuntu-latest`, while only `-darwin` baselines exist). Task 6 records the numbers and changes nothing; a separate follow-up covers the stale baselines.
- **New risk R7 — i18n copy.** The design-system page renders text through `tHardcodedUi.raw('appHomeDesignSystemPage.…')`. New copy needs a key in all 8 files under `apps/web/translations/` (`de es en fr it ja pt zh`). The `i18n:strict` audit script exists but is **not** wired into `.github/workflows`, so it is not a blocking gate — still, add all 8 to keep the audit clean.
- **R3 remains genuinely open.** Descriptor support is verified in Chromium only. Task 1 is the gate.
- **R1 remains open and is Jay's call.** Does the Displaay licence cover self-hosted webfonts? Pre-existing exposure — the four current files are already served from `public/`. This change does not increase it. Ask, but do not block on it.

---

## Section C — File structure


| Path                                                           | Change            | Responsibility after the change                                                                                                             |
| -------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/public/fonts/roobert/RoobertCollectionVF.woff2`      | **create** (copy) | The single 300 KB three-axis binary. All four families read it.                                                                             |
| `apps/web/public/fonts/roobert/RoobertUprightsVF.woff2`        | **delete**        | —                                                                                                                                           |
| `apps/web/public/fonts/roobert/RoobertItalicsVF.woff2`         | **delete**        | —                                                                                                                                           |
| `apps/web/public/fonts/roobert/RoobertMonoUprightsVF.woff2`    | **delete**        | —                                                                                                                                           |
| `apps/web/public/fonts/roobert/RoobertMonoItalicsVF.woff2`     | **delete**        | —                                                                                                                                           |
| `apps/web/src/app/(system)/fonts/roobert.ts`                   | **delete**        | Replaced by `@font-face` in `globals.css`.                                                                                                  |
| `apps/web/src/app/(system)/fonts/roobert-mono.ts`              | **delete**        | Replaced by `@font-face` in `globals.css`.                                                                                                  |
| `apps/web/src/app/globals.css`                                 | modify            | Owns the four `@font-face` rules, the `--font-*` family tokens, the ten `--font-weight-*` tokens, and the element-level mono feature reset. |
| `apps/web/src/app/layout.tsx`                                  | modify            | Drops both `localFont` imports, the `cn()` className call, and the stale preload comment; adds the explicit `<link rel="preload">`.         |
| `apps/web/src/app/(public)/(marketing)/design-system/page.tsx` | modify            | Documents SemiMono in the Typography section.                                                                                               |
| `apps/web/translations/{de,en,es,fr,it,ja,pt,zh}.json`         | modify            | The SemiMono copy keys.                                                                                                                     |
| `tests/typography/playwright.config.ts`                        | **create**        | Chromium + Firefox + WebKit projects for font assertions.                                                                                   |
| `tests/typography/roobert.spec.ts`                             | **create**        | The automated F3 regression test, the single-request assertion, the weight ladder, and the axis assertions.                                 |
| `tests/package.json`                                           | modify            | Adds the `test:typography` script.                                                                                                          |
| `tests/visual/__screenshots__/landing.visual.spec.ts/*.png`    | regenerate        | Baselines refreshed for the new rendering.                                                                                                  |


`globals.css` is 1776 lines and already the established home for app-wide type. Adding to it follows the existing pattern; do not split it.

---

## Section D — Progress tracking in Linear

Jay tracks this work in Linear. Treat the Linear issues as the source of truth for
*status*; this file stays the source of truth for *instructions*.

### The workspace, verified

`Jay` is a **team**, not a project. Do not search for a project called "jay" — there
isn't one. These IDs were read from the live workspace on 2026-07-30; prefer the name
strings, and fall back to the IDs if a name lookup is ambiguous.


| Thing                     | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| Workspace                 | `sutharjay` — `https://linear.app/sutharjay`           |
| Team                      | `Jay` · `f7441bb1-8c0d-4c7e-9eca-36a7ad847f94`         |
| Issue state — not started | `Todo` · `b97fcb16-4c4d-4b8f-a347-2997b559967a`        |
| Issue state — active      | `In Progress` · `8b1f214f-5ab0-4845-a566-873e53196301` |
| Issue state — finished    | `Done` · `937ab6aa-5658-4bc9-8ea9-efff43a6c72c`        |
| Issue state — dropped     | `Canceled` · `a2aa2c3f-ed35-4ba6-ab3d-6b7a9a89a561`    |
| Issue state — deferred    | `Backlog` · `f5a5031c-a63d-4073-80ff-54547527502b`     |
| Project status — active   | `In Progress` · `f1361612-b4be-49cd-8d65-3dc344ff997f` |
| Project status — finished | `Completed` · `3fade6d9-9662-4514-bb10-47841ff0c6a4`   |


The `Jay` team already holds 6 projects. `**Domain Enrichment Pipeline**`
(`https://linear.app/sutharjay/project/domain-enrichment-pipeline-0b846cfe665a`) is
the precedent to copy: one Linear project per work stream, issues inside it, closed
out when the work shipped. Match that shape.

### Tool access

The Linear MCP tools are **deferred** — their schemas are not loaded at session start,
and calling one directly fails with `InputValidationError`. Load them first:

```
ToolSearch("select:mcp__claude_ai_Linear__save_project,mcp__claude_ai_Linear__save_issue,mcp__claude_ai_Linear__save_comment,mcp__claude_ai_Linear__list_issues,mcp__claude_ai_Linear__get_issue")
```

Pass Markdown to `description` and `body` with **literal newlines**, not `\n` escape
sequences.

### The protocol, per task

Each of Tasks 1–7 gets exactly one Linear issue. For every task:

1. **Before the first step** — set the issue to `In Progress`.
2. **While working** — if you discover something that changes the plan, comment on the
  issue with what you found and what you did about it. A silent deviation is the one
   failure mode this protocol exists to prevent.
3. **After the last verification step** — comment with the **real command and its real
  output** (the same evidence the task already requires), then set the issue to `Done`.
4. **If blocked** — leave it `In Progress`, comment with what is blocking and what
  would unblock it, and move to the next task only if it has no dependency on this
   one. Do not silently skip.

Rules that are not negotiable:

- `**Done` requires pasted evidence.** An issue with no output comment is not done,
regardless of what the checkboxes say.
- **Never mark Task 1 `Done` if Firefox or WebKit failed.** That is a `Blocked`
comment and an escalation, not a completion — the whole design branches on it.
- **Do not close the project** until Task 7 Step 5 passes against `dev.kortix.com`.
Merged is not shipped.

---

## Task 0: Create the Linear project and issues

Do this first, before Task 1. It is bookkeeping, so it has no tests — but nothing else
starts until Jay can see the board.

**Files:** none. This task only writes to Linear.

**Interfaces:**

- Produces: a Linear project plus 8 issue identifiers (`JAY-*`) that Tasks 1–7 and the
C3 decision reference by title.

- [ ] **Step 1: Load the Linear tool schemas**

```
ToolSearch("select:mcp__claude_ai_Linear__save_project,mcp__claude_ai_Linear__save_issue,mcp__claude_ai_Linear__save_comment,mcp__claude_ai_Linear__list_issues,mcp__claude_ai_Linear__get_issue")
```

- [ ] **Step 2: Check the project does not already exist**

Someone may have started this. Do not create a duplicate.

```
mcp__claude_ai_Linear__list_projects  team="Jay"  query="Roobert"
```

If a `Roobert` project exists, adopt it and skip to Step 4.

- [ ] **Step 3: Create the project**

`save_project` with:

- `team`: `Jay`
- `name`: `Roobert Single-File Font`
- `status`: `In Progress`
- `description`:

```markdown
Replace apps/web's four Roobert .woff2 files (528 KB, up to 4 requests) with the
foundry's own three-axis RoobertCollectionVF.woff2 (300 KB, 1 request) — 43% smaller.

Fixes three things on the way:
- Monospace alignment is broken in production. `->` `<-` (calt) and `tt` `ff` `ffi`
  (liga) collapse monospace cells, so `getAttribute->off` renders three cells short.
- The weight ladder is a lie. The CSS declares 100–900 while the wght axis is
  300–900, so font-thin and font-extralight silently render as Light 300.
- Display-only stylistic sets leak into code text, swapping E F L y : ; ? — and `:`
  and `;` are everywhere in TypeScript.

Also exposes font-semimono (MONO=60) for IDs, hashes and timestamps.

Scope is apps/web only; apps/mobile is deferred by decision.
The licence forbids modifying the binary, so nothing is subsetted or re-generated —
this adopts a file the foundry already ships.

Spec: docs/superpowers/specs/2026-07-30-roobert-single-file-design.md
Plan: docs/superpowers/plans/2026-07-30-roobert-single-file-font.md
Worktree: /Users/jay/root/kortix/suna-font (branch `font`)
```

Record the returned project URL — it goes in the PR body at Task 7.

- [ ] **Step 4: Create the eight issues**

All in team `Jay`, all with `project` set to `Roobert Single-File Font`. Create the
decision issue **first** so the others can reference it as a blocker.


| #   | Title                                                              | State  | Priority   | Notes for the description                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------ | ------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `Decide the tenth weight token name (blocks weight ladder)`        | `Todo` | `1` Urgent | Tailwind has no `font-950`; the `--font-weight-*` namespace ships nine names. Recommendation: `font-heavy` → `wght 900`, matching Roobert's own instance name at 900. Needs Jay. Blocks the weight-ladder issue. Assign to Jay.                         |
| 2   | `Gate: verify @font-face descriptor support in Firefox and WebKit` | `Todo` | `1` Urgent | Task 1. The whole design branches here. If either engine ignores the descriptor, D2 must be redesigned around per-element `font-variation-settings` utilities. Only `chromium-1228` is installed — `pnpm exec playwright install firefox webkit` first. |
| 3   | `Adopt RoobertCollectionVF and author the four font families`      | `Todo` | `2` High   | Task 2. 528 KB / 4 files → 300 KB / 1 file. Four `@font-face` rules share one `src`; drop `next/font/local` and preload explicitly. Blocked by the gate issue.                                                                                          |
| 4   | `Fix monospace cell alignment in Roobert Mono`                     | `Todo` | `2` High   | Task 3. The live bug. `font-variant-ligatures: none` on `code, pre, .font-mono`; `calt off` alone is not enough. Must be element-level — the `@font-face` descriptor loses to `html`/`body` inheritance (see plan Section B, C1).                       |
| 5   | `Map all ten font-weight names onto the real 300–900 axis`         | `Todo` | `3` Medium | Task 4. Blocked by the decision issue. 400–800 unchanged; only light (300→368) and black (900→870) shift, across 3 files.                                                                                                                               |
| 6   | `Expose and document Roobert SemiMono (font-semimono)`             | `Todo` | `3` Medium | Task 5. `MONO=60` for IDs, hashes, timestamps. NOT monospaced — never for code or column-aligned tables. Needs copy keys in all 8 `apps/web/translations/*.json`.                                                                                       |
| 7   | `Verify locally across three engines and refresh visual baselines` | `Todo` | `2` High   | Task 6. Landing snapshots at `maxDiffPixelRatio: 0.01` will move; inspect the diff before accepting. Also a11y and a real production build.                                                                                                             |
| 8   | `Ship: PR, merge, Deploy Dev, verify on dev.kortix.com`            | `Todo` | `2` High   | Task 7. Local verification does not replace the deployed check. Confirm the deployed artifact carries the merged SHA — a healthy `/health` is not deployment proof.                                                                                     |


Each description must open with a one-line pointer back to this plan and the task
number, so an agent picking up a single issue can find its instructions:

```markdown
Task N of docs/superpowers/plans/2026-07-30-roobert-single-file-font.md
```

- [ ] **Step 5: Wire the blockers**

- Issue 5 (`weight ladder`) `blockedBy` issue 1 (`tenth weight token name`).
- Issues 3, 4, 5, 6 `blockedBy` issue 2 (`descriptor gate`).
- Issue 8 (`Ship`) `blockedBy` issue 7 (`Verify locally`).

- [ ] **Step 6: Confirm the board reads correctly**

```
mcp__claude_ai_Linear__list_issues  team="Jay"  project="Roobert Single-File Font"
```

Expected: 8 issues, all `Todo`, blockers set as above. Report the project URL and the
8 issue identifiers to the operator before starting Task 1.

---

## Task 1: Cross-browser descriptor gate (spec R3)

This gates the whole design. If Firefox or WebKit ignores the `font-variation-settings` descriptor, D2 collapses and the fallback is per-element `font-variation-settings` utility classes — a materially different plan. Run this **before** touching `apps/web`.

**Files:**

- Create: `tests/typography/playwright.config.ts`
- Create: `tests/typography/descriptor-support.spec.ts`
- Create: `tests/typography/fixtures/descriptor.html`
- Modify: `tests/package.json`

**Interfaces:**

- Produces: the `test:typography` npm script and the `tests/typography/` config that Task 3 reuses for `roobert.spec.ts`.

**Linear:** issue JAY-124 `Gate: verify @font-face descriptor support in Firefox and WebKit`, already `In Progress` and carrying the escalation comment. Set `Done` once the six results pass.

**Status:** the gate has RUN and its question is answered — see Section B, C4. WebKit
ignores the descriptor; element-level settings work everywhere; Jay approved the
replacement design on 2026-07-30. What remains here is converting the one-shot gate into
the permanent regression test described below, and fixing the download-count assertion
that measured request events instead of real fetches.

- [ ] **Step 1: Confirm the source binary exists**

The gate must run before `apps/web` is touched, so it reads the copy that already
lives in `apps/mobile`. **Do not copy the binary into `tests/`** — the repo would then
carry three copies of the same 300 KB file, and the licence is a reason to keep
duplication at zero, not one more than necessary. The fixture references it by
relative path.

```bash
cd /Users/jay/root/kortix/suna-font
mkdir -p tests/typography/fixtures
ls -la apps/mobile/assets/font/Roobert/RoobertCollectionVF.woff2
```

Expected: the file exists, ~300 KB (307200 bytes ±).

- [ ] **Step 2: Write the fixture page**

Create `tests/typography/fixtures/descriptor.html`. The `src` is a **server-absolute
path**, not a relative one, because the page is served over HTTP from the repo root —
`@font-face` fetches are blocked under `file://`, which silently yields a fallback face
and plausible-looking numbers that mean nothing.

The page declares **both** techniques side by side, because the test asserts one works
and the other does not. `DESC-*` families pin axes with the `@font-face` descriptor;
`ELEM` is unpinned and gets its axes from element-level `font-variation-settings`.

```html
<!doctype html>
<meta charset="utf-8" />
<title>Roobert axis-pinning technique support</title>
<style>
  /* --- Technique A: axes pinned by @font-face DESCRIPTOR (rejected) --------
     Works in Chromium and Firefox, IGNORED by WebKit. Kept in the fixture so
     the test pins WHY the app does not use it. */
  @font-face {
    font-family: 'DESC-Sans';
    font-weight: 300 900;
    src: url('/apps/mobile/assets/font/Roobert/RoobertCollectionVF.woff2')
      format('woff2');
    font-variation-settings: 'MONO' 0;
  }
  @font-face {
    font-family: 'DESC-Mono';
    font-weight: 300 900;
    src: url('/apps/mobile/assets/font/Roobert/RoobertCollectionVF.woff2')
      format('woff2');
    font-variation-settings: 'MONO' 100;
  }

  /* --- Technique B: ONE family, axes set at ELEMENT level (adopted) --------
     Works in all three engines. This is what apps/web ships. */
  @font-face {
    font-family: 'ELEM';
    font-weight: 300 900;
    src: url('/apps/mobile/assets/font/Roobert/RoobertCollectionVF.woff2')
      format('woff2');
  }
  body { margin: 0; font-size: 48px; }
</style>
<body></body>
```

- [ ] **Step 3: Write the config**

Create `tests/typography/playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';

// Two targets live in this config:
//   roobert.spec.ts            -> the running app, via baseURL
//   descriptor-support.spec.ts -> a static fixture, via FIXTURE_ORIGIN
// The fixture needs a real HTTP origin: @font-face fetches are blocked under
// file://, which yields a fallback face and measurements that look plausible
// and mean nothing. webServer serves the repo root so the fixture page and the
// font binary are both reachable by absolute path.
const baseURL = process.env.E2E_BASE_URL || 'http://localhost:3000';
const FIXTURE_PORT = 8842;

export default defineConfig({
  testDir: '.',
  testMatch: ['**/*.spec.ts'],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['list'],
    ['junit', { outputFile: '../test-results/typography/junit.xml' }],
  ],
  outputDir: '../test-results/typography/artifacts',
  // cwd defaults to this config's directory, so ../.. is the repo root.
  webServer: {
    command: `python3 -m http.server ${FIXTURE_PORT} --bind 127.0.0.1 --directory ../..`,
    url: `http://127.0.0.1:${FIXTURE_PORT}/apps/mobile/assets/font/Roobert/RoobertCollectionVF.woff2`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
```

- [ ] **Step 4: Write the technique test**

Create `tests/typography/descriptor-support.spec.ts`. Two tests: the adopted
element-level technique must work in every engine, and the rejected descriptor
technique is pinned as engine-dependent so nobody "simplifies" back to it.

**Note on counting downloads.** Do NOT assert on `page.on('request')` events.
Firefox emits one event per `@font-face` rule sharing a URL while performing only
**one** network fetch — the rest are cache hits. Count `response` events that were
not served from cache, via `response.request().timing()`, or assert on the server.
Here we count distinct URLs, which is what the payload claim actually means.

```ts
import { test, expect } from '@playwright/test';

// Served by the webServer in playwright.config.ts, rooted at the repo root.
// Must be HTTP — @font-face is blocked under file://.
const FIXTURE = 'http://127.0.0.1:8842/tests/typography/fixtures/descriptor.html';

const measureIn = (page: import('@playwright/test').Page) =>
  page.evaluate(async () => {
    for (const f of ['DESC-Sans', 'DESC-Mono', 'ELEM']) {
      await document.fonts.load(`400 48px "${f}"`);
    }
    await document.fonts.ready;

    const measure = (css: string, text = 'Hamburgefonstiv 0123') => {
      const s = document.createElement('span');
      s.style.cssText =
        'display:inline-block;white-space:pre;font-size:48px;' + css;
      s.textContent = text;
      document.body.appendChild(s);
      const r = document.createRange();
      r.selectNodeContents(s);
      const w = r.getBoundingClientRect().width;
      s.remove();
      return Math.round(w * 100) / 100;
    };

    const el = (mono: number, ital = 0, text?: string) =>
      measure(
        `font-family:'ELEM';font-variation-settings:'MONO' ${mono},'ital' ${ital}`,
        text,
      );

    return {
      // A fetch failure would make every family identical, which reads exactly
      // like "technique unsupported". Report load state so that is unmistakable.
      loaded: [...document.fonts].map((f) => `${f.family}:${f.status}`),
      // Technique B — element level (adopted).
      elemSans: el(0),
      elemSemi: el(60),
      elemMono: el(100),
      elemItal: el(0, 11),
      elemMonoW: el(100, 0, 'WWWWWWWWWW'),
      elemMonoM: el(100, 0, 'mmmmmmmmmm'),
      elemSemiW: el(60, 0, 'WWWWWWWWWW'),
      elemSemiM: el(60, 0, 'mmmmmmmmmm'),
      elemW300: measure("font-family:'ELEM';font-weight:300"),
      elemW900: measure("font-family:'ELEM';font-weight:900"),
      // Technique A — descriptor (rejected).
      descSans: measure("font-family:'DESC-Sans'"),
      descMono: measure("font-family:'DESC-Mono'"),
    };
  });

test.describe('Roobert axis pinning', () => {
  test('element-level font-variation-settings pins every axis, in every engine', async ({
    page,
  }) => {
    const urls = new Set<string>();
    page.on('response', (r) => {
      if (r.url().endsWith('.woff2')) urls.add(r.url());
    });

    await page.goto(FIXTURE);
    const m = await measureIn(page);

    expect(
      m.loaded.filter((s) => s.endsWith(':loaded')).length,
      `fonts did not load — got ${JSON.stringify(m.loaded)}`,
    ).toBeGreaterThanOrEqual(3);

    // MONO=100 must be truly monospaced: W and m share one advance.
    expect(
      Math.abs(m.elemMonoW - m.elemMonoM),
      `MONO=100 not monospaced: W=${m.elemMonoW} m=${m.elemMonoM}`,
    ).toBeLessThan(0.5);

    // MONO=60 must NOT be monospaced (spec F7).
    expect(
      Math.abs(m.elemSemiW - m.elemSemiM),
      `MONO=60 unexpectedly monospaced: W=${m.elemSemiW} m=${m.elemSemiM}`,
    ).toBeGreaterThan(5);

    // The three MONO stops must be ordered sans < semi < mono.
    expect(m.elemSans).toBeLessThan(m.elemSemi);
    expect(m.elemSemi).toBeLessThan(m.elemMono);

    // ital=11 must actually slant.
    expect(Math.abs(m.elemItal - m.elemSans)).toBeGreaterThan(0.5);

    // Pinning MONO must not lock wght — font-weight still drives the axis.
    expect(m.elemW300).not.toBe(m.elemW900);

    // The payload claim: all faces come from ONE binary URL.
    expect([...urls]).toHaveLength(1);
  });

  test('the @font-face descriptor is NOT portable — this is why we do not use it', async ({
    page,
    browserName,
  }) => {
    await page.goto(FIXTURE);
    const m = await measureIn(page);
    const descriptorPins = Math.abs(m.descMono - m.descSans) > 5;

    if (browserName === 'webkit') {
      // WebKit ignores the descriptor entirely: MONO=100 renders proportional,
      // so shipping descriptor-pinned families would give Safari users code in
      // a proportional face. If this ever starts passing, WebKit gained support
      // and the app COULD be simplified — revisit deliberately, do not just
      // flip the assertion.
      expect(
        descriptorPins,
        `WebKit now honours the @font-face descriptor (sans=${m.descSans} mono=${m.descMono}). Revisit the design.`,
      ).toBe(false);
    } else {
      expect(
        descriptorPins,
        `${browserName} should honour the descriptor (sans=${m.descSans} mono=${m.descMono})`,
      ).toBe(true);
    }
  });
});
```

- [ ] **Step 5: Add the test script**

In `tests/package.json`, add alongside `test:visual`:

```json
"test:typography": "playwright test --config typography/playwright.config.ts",
```

- [ ] **Step 6: Run the gate across all three engines**

```bash
cd /Users/jay/root/kortix/suna-font/tests && pnpm test:typography -g "axis pinning"
```

Expected: **6 passed** — two tests across chromium, firefox and webkit.

The gate question has already been answered (see Section B, C4): the descriptor is not
portable, and element-level settings are. These tests lock that answer in so a future
engine change or a well-meaning simplification cannot silently regress it.

If the element-level test fails on any engine, STOP and escalate — that would invalidate
the adopted design, not just an implementation detail.

- [ ] **Step 7: Commit** (only when the operator confirms)

```bash
cd /Users/jay/root/kortix/suna-font
git add tests/typography tests/package.json
git commit -m "test(web): pin Roobert axis-pinning technique across three engines

WebKit ignores the @font-face font-variation-settings descriptor: every family
renders the default instance, so MONO=100 measures W 475.68 vs m 423.36 and is
not monospaced. Descriptor-pinned families would give Safari users code in a
proportional face. No src format() syntax changes this.

Element-level font-variation-settings works in Chromium, Firefox and WebKit
alike, so that is what apps/web will use.

Both techniques stay in the fixture and both are asserted: the element-level
one must work everywhere, and the descriptor is pinned as engine-dependent so
it cannot be reintroduced by a well-meaning simplification.

Counts distinct binary URLs rather than request events. Firefox emits one
request event per @font-face rule sharing a URL while fetching only once, so
an event count would have read as four downloads."
```

- [ ] **Step 8: Update Linear**

Comment on JAY-124 with the verbatim six-result output from Step 6, then set it to
`Done`. The escalation comment recording the WebKit finding is already on the issue —
leave it; it is the record of why the design changed.

---

## Task 2: Adopt the single binary and author the four families

**Files:**

- Create: `apps/web/public/fonts/roobert/RoobertCollectionVF.woff2`
- Delete: the four old `.woff2` files, `apps/web/src/app/(system)/fonts/roobert.ts`, `apps/web/src/app/(system)/fonts/roobert-mono.ts`
- Modify: `apps/web/src/app/globals.css` (new `@font-face` block; lines 179–180)
- Modify: `apps/web/src/app/layout.tsx` (lines 18, 25, 26, 176, 190)

**Interfaces:**

- Consumes: the descriptor support proven in Task 1.
- Produces: CSS families `Roobert`, `Roobert Mono`, `Roobert SemiMono`, and the theme tokens `--font-sans`, `--font-mono`, `--font-semimono`. Tasks 3–5 depend on these exact family strings.

**Linear:** issue `Adopt RoobertCollectionVF and author the four font families`. Set `In Progress` before Step 1.

- [ ] **Step 1: Copy the binary in, delete the four old files**

```bash
cd /Users/jay/root/kortix/suna-font
cp apps/mobile/assets/font/Roobert/RoobertCollectionVF.woff2 apps/web/public/fonts/roobert/
rm apps/web/public/fonts/roobert/RoobertUprightsVF.woff2 \
   apps/web/public/fonts/roobert/RoobertItalicsVF.woff2 \
   apps/web/public/fonts/roobert/RoobertMonoUprightsVF.woff2 \
   apps/web/public/fonts/roobert/RoobertMonoItalicsVF.woff2
ls -la apps/web/public/fonts/roobert/
du -ch apps/web/public/fonts/roobert/*.woff2 | tail -1
```

Expected: one file, ~300 KB total (down from 528 KB).

- [ ] **Step 2: Add the `@font-face` block to `globals.css`**

Insert immediately after the `@source` lines (currently line 9), before the Fumadocs override comment. `@font-face` must be top-level.

```css
/* ─── Roobert — one variable font, three axes ─────────────────────────────────
   RoobertCollectionVF.woff2 is the foundry's three-axis master:
     wght 300–900 · ital 0–11 · MONO 0–100 (0 sans · 60 SemiMono · 100 mono)

   There is ONE family. The sans / SemiMono / mono / italic distinctions are
   axis positions, not separate families, and they are pinned at ELEMENT level
   via the custom properties below.

   Why not the `font-variation-settings` @font-face descriptor (the obvious
   approach)? WebKit ignores it outright — every family renders the default
   instance, so Safari would show all code in a proportional face. Measured:
   MONO=100 gives W 475.68 vs m 423.36 there. No `src` format() syntax fixes
   it. Element-level settings work in Chromium, Firefox AND WebKit.

   Do NOT convert this to next/font/local: it fingerprints per call, and the
   four calls this replaced would emit the same binary four times (~1.2 MB),
   worse than the four files it replaced. The explicit <link rel="preload"> in
   layout.tsx covers what next/font used to do automatically.

   The licence forbids modifying, subsetting, or renaming this binary. */
@font-face {
  font-family: 'Roobert';
  font-style: normal;
  font-weight: 300 900;
  font-display: swap;
  src: url('/fonts/roobert/RoobertCollectionVF.woff2') format('woff2');
}

:root {
  --rb-mono: 0;
  --rb-ital: 0;
}

/* Declared on `*` deliberately. `font-variation-settings` is an inherited
   property, so an element that only changes `--rb-mono` would inherit its
   parent's ALREADY-SUBSTITUTED value and never re-resolve. Declaring it on
   every element makes each one compute its own value from the custom
   properties, which do inherit. This is also what lets `font-mono` and
   `italic` compose: the two axes are independent variables.
   `wght` is deliberately absent — `font-weight` still drives it. */
* {
  font-variation-settings: 'MONO' var(--rb-mono, 0), 'ital' var(--rb-ital, 0);
}

/* `ital` is a 0–11 axis, not 0–1. CSS `font-style: italic` alone would land on
   ital=1 and render roughly 9% of the intended slant, so set the axis. */
em,
i,
.italic {
  --rb-ital: 11;
}
```

The `--rb-mono` stops for mono and SemiMono are set in Task 3 and Task 5, on the rules
that already own those surfaces (`code, pre, .font-mono` and `.font-semimono`).

- [ ] **Step 3: Repoint the family tokens**

`globals.css:231-234` currently reads:

```css
  --font-sans: var(--font-roobert);
  --font-mono: var(--font-roobert-mono);
```

`--font-roobert` and `--font-roobert-mono` were generated by `next/font/local` and no longer exist. Replace with real family lists.

All three tokens name the **same** family — `Roobert` is one font. They differ only in
their fallback stacks, which is what they are actually for: if Roobert fails to load,
`font-mono` must still fall back to a monospace, not a sans. Mono-ness within Roobert
comes from `--rb-mono`, not from the family name.

```css
  --font-sans: 'Roobert', ui-sans-serif, system-ui, -apple-system, 'Segoe UI',
    'Helvetica Neue', sans-serif;
  --font-mono: 'Roobert', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --font-semimono: 'Roobert', ui-sans-serif, system-ui, sans-serif;
```

- [ ] **Step 4: Rewire `layout.tsx`**

Four edits.

Delete line 18 — `cn()` is used only at line 176, which stops needing it:

```ts
import { cn } from '@/lib/utils';
```

Delete lines 25–26:

```ts
import { roobert } from './(system)/fonts/roobert';
import { roobertMono } from './(system)/fonts/roobert-mono';
```

Line 176 — drop the generated CSS-variable classNames:

```tsx
      className="notranslate"
```

Line 190 — replace the now-false comment with the real preload:

```tsx
        {/* Roobert is one variable font covering every weight, the mono and
            SemiMono axis stops, and italics (see the @font-face block in
            globals.css). next/font/local no longer manages it, so preload
            explicitly — without this the browser only discovers the font after
            CSS parses and text flashes in the fallback. */}
        <link
          rel="preload"
          href="/fonts/roobert/RoobertCollectionVF.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
```

- [ ] **Step 5: Delete the two font modules**

```bash
cd /Users/jay/root/kortix/suna-font
rm "apps/web/src/app/(system)/fonts/roobert.ts" "apps/web/src/app/(system)/fonts/roobert-mono.ts"
rmdir "apps/web/src/app/(system)/fonts" 2>/dev/null || ls "apps/web/src/app/(system)/fonts"
```

- [ ] **Step 6: Prove no dangling references remain**

```bash
cd /Users/jay/root/kortix/suna-font
grep -rn "font-roobert\|fonts/roobert'\|RoobertUprightsVF\|RoobertItalicsVF\|RoobertMonoUprightsVF\|RoobertMonoItalicsVF" \
  apps/web/src apps/web/public 2>/dev/null | grep -v node_modules
```

Expected: no output.

- [ ] **Step 7: Lint and typecheck**

```bash
cd /Users/jay/root/kortix/suna-font/apps/web
npx eslint src/app/layout.tsx
npx tsc --noEmit 2>&1 | grep -E "layout\.tsx|fonts/roobert" || echo "no errors in changed files"
```

`tsc` emits ~1500 bogus `TS2786`/`IntrinsicAttributes` errors from a React 19↔18 types mismatch. Ignore those; the grep isolates our files.

- [ ] **Step 8: Verify one request, correct family, in the running app**

With the dev server up (Section A3):

```bash
cd /Users/jay/root/kortix/suna-font/tests
E2E_BASE_URL=http://127.0.0.1:3100 pnpm exec playwright test \
  --config typography/playwright.config.ts --project chromium -g "descriptor" --reporter=list
```

Then confirm against the real app in Chromium — assert the computed family, not just that pixels appeared:

```bash
cd /Users/jay/root/kortix/suna-font
node -e "
const pkg = require('./apps/web/node_modules/@playwright/test/index.js');
(async () => {
  const b = await pkg.chromium.launch();
  const p = await b.newPage();
  const woff2 = [];
  p.on('request', r => { if (r.url().endsWith('.woff2')) woff2.push(r.url()); });
  await p.goto('http://127.0.0.1:3100/design-system', { waitUntil: 'networkidle' });
  const fam = await p.evaluate(() => getComputedStyle(document.body).fontFamily);
  const pre = await p.evaluate(() => {
    const l = document.querySelector('link[rel=preload][as=font]');
    return l && l.getAttribute('href');
  });
  console.log('body fontFamily :', fam);
  console.log('preload href    :', pre);
  console.log('woff2 requests  :', woff2.length, woff2);
  await b.close();
})();
"
```

Expected: `body fontFamily` contains `Roobert`; `preload href` is `/fonts/roobert/RoobertCollectionVF.woff2`; `woff2 requests: 1`.

- [ ] **Step 9: Commit** (only when the operator confirms)

```bash
cd /Users/jay/root/kortix/suna-font
git add apps/web/public/fonts/roobert apps/web/src/app/globals.css apps/web/src/app/layout.tsx
git add -A "apps/web/src/app/(system)"
git commit -m "refactor(web): serve Roobert from one variable font instead of four files

528 KB across 4 woff2 files becomes 300 KB in 1, and one request instead of up
to four.

There is now ONE font family. Sans, SemiMono, mono and italic are positions on
the MONO and ital axes, pinned at element level through CSS custom properties
rather than with the @font-face font-variation-settings descriptor. WebKit
ignores that descriptor: every family renders the default instance, so MONO=100
measures W 475.68 vs m 423.36 and Safari would have shown all code in a
proportional face. No src format() syntax changes this. Element-level settings
work in Chromium, Firefox and WebKit alike.

font-variation-settings is declared on * deliberately. It is an inherited
property, so an element that only changed --rb-mono would inherit its parent's
already-substituted value and never re-resolve.

Replaces next/font/local, which fingerprints per call and would have emitted
the same binary four times. Preload is now explicit in layout.tsx.

Also corrects font-weight from '100 900' to the real 300-900 axis, and sets
ital=11 for italics (the axis is 0-11, so font-style: italic alone rendered
roughly 9% of the intended slant)."
```

- [ ] **Step 10: Update Linear**

Comment with the Step 1 payload output (`du -ch`, showing 300 KB down from 528 KB), the
Step 6 dangling-reference grep returning nothing, and the Step 8 browser output
(`woff2 requests: 1`). Then set the issue to `Done`.

---

## Task 3: Fix the monospace alignment bug (spec F3/D4) + regression test

The live bug. Five character sequences collapse monospace cells: `->`, `<-` (`calt`) and `tt`, `ff`, `ffi` (`liga`). `getAttribute->off` renders three cells short. Per **C1** the fix is element-level, not in `@font-face`.

**Files:**

- Modify: `apps/web/src/app/globals.css` — `html` block at `:731` and `body` block at `:750` (drop dead `ss10` from each), and the `code, pre, .font-mono` rule at `:779-785`

> **Locate by anchor text, not by line number.** Task 2 inserted ~54 lines near the top of
> `globals.css`, so any number quoted from the original file is stale. The numbers above
> were re-read after Task 2 landed, but verify with `grep -n` before editing.
- Create: `tests/typography/roobert.spec.ts`

**Interfaces:**

- Consumes: the `Roobert Mono` family and `--font-mono` token from Task 2.
- Produces: the automated F3 regression test that Task 6 re-runs.

**Linear:** issue `Fix monospace cell alignment in Roobert Mono`. Set `In Progress` before Step 1. This is the user-visible bug in the set — the `Done` comment must show the before and after width arrays, not just "tests pass".

- [ ] **Step 0: De-duplicate the fixture origin (carried over from Task 1's review)**

Task 1 left `FIXTURE` in `descriptor-support.spec.ts` hardcoding `http://127.0.0.1:8842`,
duplicating `FIXTURE_PORT` in `playwright.config.ts`. Two files must now change together
or the suite silently breaks. Since this task adds a second spec to the same directory,
fix it here.

Create `tests/typography/fixture-origin.ts`:

```ts
// Single source of truth for the static-fixture server. playwright.config.ts
// starts the server on this port; specs read the origin from here so the two
// can never drift.
export const FIXTURE_PORT = 8842;
export const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
```

Then import it in `playwright.config.ts` (replacing its local `FIXTURE_PORT` const) and
in `descriptor-support.spec.ts`:

```ts
import { FIXTURE_ORIGIN } from './fixture-origin';

const FIXTURE = `${FIXTURE_ORIGIN}/tests/typography/fixtures/descriptor.html`;
```

Re-run `pnpm test:typography -g "axis pinning"` afterwards and confirm **6 passed** still.

- [ ] **Step 1: Write the failing regression test**

Create `tests/typography/roobert.spec.ts`. It runs against the **real app page** so it exercises the true cascade, including the `html`/`body` inheritance that C1 uncovered.

```ts
import { test, expect } from '@playwright/test';

// Each line is exactly 17 characters and contains the sequences that collapse:
// '->' and '<-' come from `calt`; 'tt', 'ff', 'ffi' come from `liga`.
// In a monospaced face all five MUST measure identically.
const LINES_17 = [
  'getAttribute->off', // -> plus tt
  'setTimeout offset', // tt plus ff
  'diff pattern buff', // ff plus tt
  'WWWWWWWWWWWWWWWWW', // widest glyph
  'iiiiiiiiiiiiiiiii', // narrowest glyph
];

test.describe('Roobert Mono', () => {
  test('keeps monospace cell alignment (F3 regression)', async ({ page }) => {
    await page.goto('/design-system', { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);

    const result = await page.evaluate((lines) => {
      const widths: number[] = [];
      let fontFamily = '';
      let ligatures = '';
      for (const line of lines) {
        const s = document.createElement('span');
        // Use the real utility class so the app's cascade is what gets tested.
        s.className = 'font-mono';
        s.style.cssText =
          'position:absolute;left:-9999px;display:inline-block;white-space:pre;font-size:32px';
        s.textContent = line;
        document.body.appendChild(s);
        const cs = getComputedStyle(s);
        fontFamily = cs.fontFamily;
        ligatures = cs.fontVariantLigatures;
        // Range, not the element box: a block would report container width.
        const r = document.createRange();
        r.selectNodeContents(s);
        widths.push(Math.round(r.getBoundingClientRect().width * 100) / 100);
        s.remove();
      }
      return {
        widths,
        fontFamily,
        ligatures,
        // `getComputedStyle().fontFamily` returns the DECLARED list, so it says
        // "Roobert, ui-monospace, …" whether or not Roobert actually loaded.
        // Only document.fonts.check tells us the face is really available.
        roobertLoaded: document.fonts.check('32px Roobert'),
      };
    }, LINES_17);

    // Guard, and it has to be this one. A system fallback monospace aligns
    // perfectly too, so the alignment assertion below passes with the font
    // entirely missing — verified by aborting the .woff2 request: spread 0.00
    // and a computed family still reading "Roobert, ui-monospace, …". Asserting
    // on the declared family name is therefore worthless here; assert the face
    // actually loaded, otherwise a deploy that 404s the font ships green.
    expect(
      result.roobertLoaded,
      'Roobert did not load — the alignment assertion below would pass on the system fallback and prove nothing',
    ).toBe(true);
    expect(result.fontFamily).toContain('Roobert');
    expect(result.ligatures).toBe('none');

    const spread = Math.max(...result.widths) - Math.min(...result.widths);
    expect(
      spread,
      `17-char lines must be equal width, got [${result.widths.join(', ')}]`,
    ).toBeLessThan(0.5);
  });

  test('does not apply display-only stylistic sets to code', async ({ page }) => {
    await page.goto('/design-system', { waitUntil: 'networkidle' });
    const features = await page.evaluate(() => {
      const s = document.createElement('span');
      s.className = 'font-mono';
      s.style.cssText = 'position:absolute;left:-9999px';
      s.textContent = 'EFLy:;?';
      document.body.appendChild(s);
      const v = getComputedStyle(s).fontFeatureSettings;
      s.remove();
      return v;
    });
    // 'zero' stays (slashed zero disambiguates 0 from O). The display sets that
    // html/body set at element level must NOT reach code text.
    expect(features).toContain('zero');
    for (const set of ['ss03', 'ss04', 'ss09', 'ss10', 'ss14']) {
      expect(features, `${set} leaked into font-mono`).not.toContain(set);
    }
  });

  test('bare <pre> and <code> use Roobert Mono, not the system mono', async ({
    page,
  }) => {
    // The UA stylesheet sets font-family: monospace on pre/code/kbd/samp and
    // that beats inheritance. globals.css must target them explicitly.
    await page.goto('/design-system', { waitUntil: 'networkidle' });
    const fams = await page.evaluate(() => {
      const out: Record<string, string> = {};
      for (const tag of ['pre', 'code']) {
        const el = document.createElement(tag);
        el.style.cssText = 'position:absolute;left:-9999px';
        el.textContent = 'const x = 1;';
        document.body.appendChild(el);
        out[tag] = getComputedStyle(el).fontFamily;
        el.remove();
      }
      return out;
    });
    expect(fams.pre).toContain('Roobert Mono');
    expect(fams.code).toContain('Roobert Mono');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/jay/root/kortix/suna-font/tests
E2E_BASE_URL=http://127.0.0.1:3100 pnpm exec playwright test \
  --config typography/playwright.config.ts --project chromium -g "Roobert Mono" --reporter=list
```

Expected: the alignment test FAILS with a spread near 60px and a widths array like `[282.3, 322.5, 282.3, 342.7, 342.7]`. The stylistic-set test FAILS because `ss03`/`ss04`/`ss09`/`ss10`/`ss14` are inherited from `html`.

- [ ] **Step 3: Apply the element-level fix**

`globals.css:779-785` currently reads:

```css
  code,
  pre,
  .font-mono {
    font-family:
      var(--font-mono), ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas,
      'Liberation Mono', 'Courier New', monospace, 'Noto Sans Mono CJK JP', 'Noto Sans Mono CJK KR',
      'Noto Sans Mono CJK SC', 'Noto Sans Mono CJK TC';
  }
```

Add the two declarations:

```css
  code,
  pre,
  .font-mono {
    font-family:
      var(--font-mono), ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas,
      'Liberation Mono', 'Courier New', monospace, 'Noto Sans Mono CJK JP', 'Noto Sans Mono CJK KR',
      'Noto Sans Mono CJK SC', 'Noto Sans Mono CJK TC';
    /* THIS is what makes the text monospaced — the family name does not.
       Roobert is one family; mono is the MONO=100 position on its axis. The `*`
       rule in the @font-face block re-substitutes this per element. */
    --rb-mono: 100;
    /* `->` `<-` (calt) and `tt` `ff` `ffi` (liga) collapse monospace cells, so
       `getAttribute->off` renders three cells short. Disabling `calt` alone
       fixes only the arrows — this single property fixes all five. */
    font-variant-ligatures: none;
    /* Reset the display-only stylistic sets. `html` and `body` set
       font-feature-settings at ELEMENT level, so they inherit here and would
       otherwise apply to code. Those sets swap E F L y : ; ? — and `:` and `;`
       are everywhere in TypeScript. `zero` stays so a slashed 0 remains
       distinguishable from O. */
    font-feature-settings: 'zero';
  }
```

- [ ] **Step 4: Delete the dead `ss10` from `html` and `body`**

`ss10` also targets `?`, and `ss09` already wins — it has never done anything. Remove it from both blocks. `globals.css:731` becomes:

```css
    font-feature-settings:
      'ss09' on,
      'ss03' on,
      'ss04' on,
      'ss14' on,
      'palt';
```

Apply the identical edit to the `body` block at `globals.css:750`. (Both blocks carry the same list; the duplication predates this change — leave the structure alone, just drop `ss10` from each.)

- [ ] **Step 5: Run the tests and watch them pass**

```bash
cd /Users/jay/root/kortix/suna-font/tests
E2E_BASE_URL=http://127.0.0.1:3100 pnpm exec playwright test \
  --config typography/playwright.config.ts --project chromium -g "Roobert Mono" --reporter=list
```

Expected: 3 passed. The alignment widths array should now be five identical values.

- [ ] **Step 6: Commit** (only when the operator confirms)

```bash
cd /Users/jay/root/kortix/suna-font
git add apps/web/src/app/globals.css tests/typography/roobert.spec.ts
git commit -m "fix(web): restore monospace cell alignment in Roobert Mono

'->' '<-' (calt) and 'tt' 'ff' 'ffi' (liga) collapsed monospace cells, so
getAttribute->off rendered three cells short and any column-aligned code or
diff went ragged. font-variant-ligatures: none fixes all five; disabling calt
alone fixes only the arrows.

The display-only stylistic sets are also reset for code. They had to move to
element level: html and body set font-feature-settings at element level, which
inherits into code/pre and overrides the @font-face descriptor, so the
descriptor on the mono face was dead config.

Drops ss10 everywhere. It targets '?' and ss09 already won, so it never did
anything."
```

- [ ] **Step 7: Update Linear**

Comment with both width arrays — the failing one from Step 2 and the flush one from
Step 5 — so the fix is legible without rerunning anything:

```markdown
Before: [282.3, 322.5, 282.3, 342.7, 342.7]  spread 60.4px
After:  [342.7, 342.7, 342.7, 342.7, 342.7]  spread 0px
```

Then set the issue to `Done`.

---

## Task 4: Ten-step weight ladder (spec D3)

**Naming settled (C3):** Jay chose `font-heavy` → `wght 900` on 2026-07-30. JAY-123 is `Done`.

**Linear:** issue JAY-127 `Map all ten font-weight names onto the real 300–900 axis`.

### C5 — Tailwind's JIT only emits utilities that appear in scanned source

A first attempt at this task measured the ten **utility classes** by injecting them as
`className` at runtime. Four failed — `font-thin`, `font-extrabold`, `font-black`,
`font-heavy` all reported the inherited `500`. The cause is not the mapping:

| Utility | Real call sites in `apps/web/src` | Resolved in test |
| --- | --- | --- |
| `font-normal` / `font-medium` / `font-semibold` / `font-bold` | 52 / 377 / 123 / 3 | ✅ |
| `font-extralight` / `font-light` | 1 / 2 | ✅ |
| `font-thin` / `font-extrabold` / `font-black` | **0 / 0 / 0** | ❌ |

Perfect correlation with call-site count. Tailwind v4 scans source text and emits a rule
only for class names it finds; a class name that exists only in a runtime `className`
assignment is invisible to it. The theme mapping itself was confirmed correct with a
temporary `@source inline()` probe — `.font-heavy { font-weight: 900 }` generates exactly
right once Tailwind has any reason to see the class.

**This is correct Tailwind behaviour, not a defect.** Emitting unused utilities would bloat
the CSS. A developer who types `font-heavy` in a component gets `font-weight: 900`.
So: **do not safelist, and do not add `@source inline()`.**

### C6 — and `@theme inline` does not expose the tokens either

A second attempt tried to sidestep C5 by reading the `--font-weight-*` custom properties
off `:root` instead of using the utilities. That premise is also wrong. The tokens live in
an `@theme **inline**` block, and `inline` is precisely the modifier that bakes the literal
value into each generated utility rather than emitting a custom property. Verified in the
running app — all ten read as `""`:

```
--font-weight-* from :root = {"thin":"","extralight":"", … ,"heavy":""}
control --font-sans        = "\"Roobert\", ui-sans-s"
```

(`--font-sans` resolving while the weights do not is a separate Tailwind detail and not
worth chasing — the point is the weight tokens are not readable from the DOM.)

### The resolution: test what a developer actually writes

Both dead ends came from trying to verify the ladder *without* real call sites. So stop
avoiding that and create them — which was always a deliverable anyway, just scheduled one
task too late.

**The `/design-system` ladder specimen moves into this task.** It is the natural home: it
is the weight-ladder deliverable, it creates the call sites that make all ten utilities
generate, and it makes the test faithful — asserting the `font-*` classes a developer types,
not a token indirection. It also satisfies discoverability: a ten-step scale nobody can see
is not shipped.

No `@theme` restructuring, no safelist, no `@source inline()`. Task 5 keeps SemiMono only.

**Files:**

- Modify: `apps/web/src/app/globals.css` — the `@theme inline` block that holds `--font-sans` (locate by anchor text, not line number)
- Modify: `apps/web/src/app/(public)/(marketing)/design-system/page.tsx` — Typography section, the ladder specimen
- Modify: `apps/web/translations/{de,en,es,fr,it,ja,pt,zh}.json` — the specimen's label copy
- Modify: `tests/typography/roobert.spec.ts`

**Interfaces:**

- Consumes: the `Roobert` family from Task 2.
- Produces: utilities `font-thin` `font-extralight` `font-light` `font-normal` `font-medium` `font-semibold` `font-bold` `font-extrabold` `font-black` `font-heavy`, all with real call sites on `/design-system`.

- [ ] **Step 0: Document the alignment threshold (carried over from Task 3's review)**

`roobert.spec.ts`'s alignment test asserts `spread < 0.5` with no stated reason. Add the
rationale so a future reader does not tighten it to `0` and get a flaky failure:

```ts
    // 0.5px, not 0: sub-pixel layout rounding leaves a residual even in a
    // perfectly monospaced face (measured 0.14px across the five lines). A
    // real ligature collapse is ~60px at 32px type, and was 411px before
    // --rb-mono landed — so this threshold cannot mask the bug it guards.
```

- [ ] **Step 1: Write the failing ladder test**

Per **C5/C6**, this asserts the `font-*` **utility classes** — what a developer actually
writes. That only works once the specimen in Step 3b gives them real call sites, so this
test is expected to fail until Step 3b lands. That is the intended red state.

Append to `tests/typography/roobert.spec.ts`:

```ts
// wght is a 300-900 axis. Tailwind's default numeric names imply 100-950 and the
// browser silently clamps, so font-thin and font-extralight both used to render
// as Light 300. These ten spread the ten names across the real axis: 400-800 are
// unchanged, only light (300->368) and black (900->870) shift.
const LADDER: Array<[string, number]> = [
  ['font-thin', 300],
  ['font-extralight', 335],
  ['font-light', 368],
  ['font-normal', 400],
  ['font-medium', 500],
  ['font-semibold', 600],
  ['font-bold', 700],
  ['font-extrabold', 800],
  ['font-black', 870],
  ['font-heavy', 900],
];

test.describe('Roobert weight ladder', () => {
  // Asserts the UTILITIES, not the --font-weight-* tokens. Two reasons, both
  // learned the hard way:
  //   1. Tailwind v4 emits a utility only when its class name appears in scanned
  //      source. These ten resolve only because /design-system names all ten
  //      literally. If this test fails with everything reporting 500, that
  //      specimen has stopped naming them literally (e.g. refactored into a loop
  //      over a variable) — the mapping has not regressed.
  //   2. The tokens live in `@theme inline`, which bakes literals into the
  //      utilities and emits NO :root custom property, so reading
  //      --font-weight-* from the DOM returns "" and proves nothing.
  test('all ten weight utilities resolve onto the real axis, distinctly', async ({
    page,
  }) => {
    await page.goto('/design-system', { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);

    const measured = await page.evaluate((ladder) => ({
      roobertLoaded: document.fonts.check('64px Roobert'),
      rows: ladder.map(([cls]) => {
        const s = document.createElement('span');
        s.className = cls;
        s.style.cssText =
          'position:absolute;left:-9999px;display:inline-block;white-space:pre;font-size:64px';
        s.textContent = 'Hamburgefonstiv 0123';
        document.body.appendChild(s);
        const r = document.createRange();
        r.selectNodeContents(s);
        const width = Math.round(r.getBoundingClientRect().width * 100) / 100;
        const weight = Number(getComputedStyle(s).fontWeight);
        s.remove();
        return { cls, weight, width };
      }),
    }), LADDER);

    // Without the real font every weight renders identically, making the
    // distinctness assertion below meaningless.
    expect(
      measured.roobertLoaded,
      'Roobert did not load — weight comparisons would be against a fallback face',
    ).toBe(true);

    for (const [cls, expected] of LADDER) {
      const row = measured.rows.find((r) => r.cls === cls)!;
      expect(
        row.weight,
        `${cls} resolved to ${row.weight}, expected ${expected}. A value of 500 means Tailwind never emitted the utility — check /design-system still names it literally.`,
      ).toBe(expected);
    }

    // Each must actually RENDER differently. A weight outside the design space
    // would still report the right font-weight while drawing an identical glyph —
    // exactly the bug this task fixes.
    const widths = measured.rows.map((r) => r.width);
    expect(
      new Set(widths).size,
      `expected 10 distinct widths, got ${JSON.stringify(measured.rows)}`,
    ).toBe(10);

    // Monotonic: a heavier step must never render narrower than a lighter one.
    for (let i = 1; i < widths.length; i++) {
      expect(
        widths[i],
        `${LADDER[i][0]} (${widths[i]}px) should exceed ${LADDER[i - 1][0]} (${widths[i - 1]}px)`,
      ).toBeGreaterThan(widths[i - 1]);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/jay/root/kortix/suna-font/tests
E2E_BASE_URL=http://127.0.0.1:3100 pnpm exec playwright test \
  --config typography/playwright.config.ts --project chromium -g "weight ladder" --reporter=list
```

Expected: FAIL, on the token assertions — `--font-weight-thin` resolves to `100` (Tailwind's default) rather than `300`, and `--font-weight-heavy` is an empty string because no such token exists yet. It must fail on `--font-weight-*` values, **not** on the `roobertLoaded` guard; a load failure means the app on 3100 is broken, not that the ladder is wrong.

- [ ] **Step 3: Add the weight tokens**

In the `@theme inline` block in `globals.css`, directly below the `--font-semimono` line added in Task 2:

```css
  /* wght is a 300–900 axis; 100, 200 and 950 do not exist in this typeface and
     the browser clamps to the ends. Spread Tailwind's ten names across the real
     axis instead of declaring weights the font cannot draw. 400–800 are
     unchanged, so no shipped UI shifts; only light and black move.
     `font-heavy` is the tenth step — Roobert's own instance at 900 is "Heavy". */
  --font-weight-thin: 300;
  --font-weight-extralight: 335;
  --font-weight-light: 368;
  --font-weight-normal: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  --font-weight-bold: 700;
  --font-weight-extrabold: 800;
  --font-weight-black: 870;
  --font-weight-heavy: 900;
```

- [ ] **Step 3b: Document the ladder on `/design-system` — this is what makes the utilities exist**

Without this the four unused utilities are never generated and Step 1's test cannot pass
(C5). It is also the discoverability half of the deliverable.

Add a ladder specimen to the Typography section of
`apps/web/src/app/(public)/(marketing)/design-system/page.tsx`, after the existing
weight samples. **Write all ten class names as literal strings in the JSX.** A lookup
table keyed by a variable, or a template string like `` `font-${name}` ``, leaves Tailwind
unable to see them and silently defeats the whole step.

```tsx
              <div className="mt-8 space-y-1">
                <span className="text-muted-foreground mb-3 block font-mono text-xs tracking-widest">
                  {tHardcodedUi.raw('appHomeDesignSystemPage.designSystemWeightLadderLabel')}
                </span>
                {[
                  { cls: 'font-thin', label: 'thin', wght: 300 },
                  { cls: 'font-extralight', label: 'extralight', wght: 335 },
                  { cls: 'font-light', label: 'light', wght: 368 },
                  { cls: 'font-normal', label: 'normal', wght: 400 },
                  { cls: 'font-medium', label: 'medium', wght: 500 },
                  { cls: 'font-semibold', label: 'semibold', wght: 600 },
                  { cls: 'font-bold', label: 'bold', wght: 700 },
                  { cls: 'font-extrabold', label: 'extrabold', wght: 800 },
                  { cls: 'font-black', label: 'black', wght: 870 },
                  { cls: 'font-heavy', label: 'heavy', wght: 900 },
                ].map((s) => (
                  <div key={s.cls} className="flex items-baseline gap-4">
                    <span className="text-muted-foreground w-28 shrink-0 font-mono text-xs">
                      {s.label}
                    </span>
                    <span className="text-muted-foreground w-10 shrink-0 font-mono text-xs tabular-nums">
                      {s.wght}
                    </span>
                    <span className={cn('text-foreground text-2xl tracking-tight', s.cls)}>
                      Kortix Computer
                    </span>
                  </div>
                ))}
              </div>
```

The `cls` values above are literal strings inside the file, so Tailwind's scanner finds
each one — that is why this shape works while a computed class name would not.

Add the label key to all 8 files in `apps/web/translations/`. English:

```json
"designSystemWeightLadderLabel": "Weight ladder · wght 300–900",
```

Keep it untranslated-but-localised sensibly in the other seven; the numerals stay as-is.

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd /Users/jay/root/kortix/suna-font/tests
E2E_BASE_URL=http://127.0.0.1:3100 pnpm exec playwright test \
  --config typography/playwright.config.ts --project chromium -g "weight ladder" --reporter=list
```

Expected: 1 passed — ten utilities each resolving to their mapped `wght`, ten distinct and
monotonically increasing widths.

If any utility still reports `500`, Tailwind did not emit it: check that Step 3b's class
names really are literal strings in the JSX and that the file is inside the Tailwind
content globs. Do **not** reach for a safelist.

- [ ] **Step 5: Eyeball the three files whose weight shifts**

Only `font-extralight` (300→335) and `font-light` (300→368) change on shipped surfaces. Three files use them:

```bash
cd /Users/jay/root/kortix/suna-font
grep -rn "font-extralight\|font-light" apps/web/src --include="*.tsx" | grep -v node_modules
```

Expected exactly: `apps/web/src/app/(app)/invites/[inviteId]/page.tsx`, `apps/web/src/components/blog/blog-cover.tsx`, `apps/web/src/components/use-cases/covers.tsx`. Load each surface in the browser and confirm the heavier light weight still reads as intended. Both shifts make text slightly heavier, never lighter, so overflow risk is minimal — but check the blog cover, where large display type shows a 68-unit shift most.

- [ ] **Step 6: Commit** (only when the operator confirms)

```bash
cd /Users/jay/root/kortix/suna-font
git add apps/web/src/app/globals.css tests/typography/roobert.spec.ts
git commit -m "feat(web): map all ten font-weight names onto Roobert's real axis

The CSS declared a 100-900 range while the wght axis is 300-900, so font-thin
and font-extralight silently rendered as Light 300. Remaps the ten Tailwind
weight tokens across the real axis so every name renders distinctly, and adds
font-heavy for the 900 ceiling (Roobert's own instance name at 900).

400-800 are unchanged, so no shipped UI shifts. Only light (300 -> 368) and
black (900 -> 870) move; the three files using font-light/font-extralight were
checked."
```

- [ ] **Step 7: Update Linear**

Comment with the ten measured widths from Step 4 and the three files checked in Step 5
(`invites/[inviteId]/page.tsx`, `blog/blog-cover.tsx`, `use-cases/covers.tsx`), noting
whether each still reads correctly. Then set the issue to `Done`.

---

## Task 5: Expose SemiMono and document it (spec D6)

**Files:**

- Modify: `apps/web/src/app/(public)/(marketing)/design-system/page.tsx` (Typography section, around lines 1215–1256)
- Modify: `apps/web/translations/{de,en,es,fr,it,ja,pt,zh}.json`
- Modify: `tests/typography/roobert.spec.ts`

**Interfaces:**

- Consumes: `--font-semimono` and the `*` axis rule from Task 2.
- Produces: the `font-semimono` utility, documented on `/design-system`.

**Extra step A for this task, from C4:** the `font-semimono` utility only sets
`font-family`, which no longer carries the axis. Add the `--rb-mono` stop to
`globals.css` in the same `@layer base` block that holds the `code, pre, .font-mono`
rule, so SemiMono actually lands at MONO=60:

```css
  /* Roobert is one family; SemiMono is the MONO=60 position on its axis.
     Without this the `font-semimono` utility would render plain sans. */
  .font-semimono {
    --rb-mono: 60;
  }
```

**Extra step B moved out of this task.** The ten-step weight-ladder specimen now lives in
Task 4, where it belongs: it is the weight deliverable, and it is what makes the ten
`font-*` utilities generate at all (plan C5). This task covers SemiMono only.

- [ ] **Step 2: Run it — it must pass immediately**

```bash
cd /Users/jay/root/kortix/suna-font/tests
E2E_BASE_URL=http://127.0.0.1:3100 pnpm exec playwright test \
  --config typography/playwright.config.ts --project chromium -g "SemiMono" --reporter=list
```

Expected: **1 passed.** Task 2 already shipped the token and the `@font-face` rule, so a
pass here confirms both. A **failure** means Task 2 is incomplete — the computed family
will read as the inherited sans instead of `Roobert SemiMono`. In that case stop and fix
Task 2 rather than editing this test.

Then prove the guard actually bites, so it is not a test that can never fail. Temporarily
change the `@font-face` rule for `Roobert SemiMono` in `globals.css` from `'MONO' 60` to
`'MONO' 100`, re-run, and confirm the test FAILS on the proportional assertion. Revert
the edit immediately and re-run to confirm it passes again. Paste both outputs — a guard
test nobody has seen fail is not yet a guard.

- [ ] **Step 3: Add the translation keys**

Add two keys to the `hardcodedUi.appHomeDesignSystemPage` object in each of the 8 files. English (`apps/web/translations/en.json`):

```json
"designSystemSemiMonoLabel": "Roobert SemiMono",
"designSystemSemiMonoNote": "MONO 60 — for IDs, hashes and timestamps. Not monospaced, so never use it for code or column-aligned tables.",
```

Use the same two keys in `de es fr it ja pt zh`, translated. Keep `Roobert SemiMono` untranslated in every locale — it is a product name.

- [ ] **Step 4: Document SemiMono on the design-system page**

In the Typography section of `apps/web/src/app/(public)/(marketing)/design-system/page.tsx`, add a SemiMono specimen immediately after the existing Roobert Mono specimen block (the `rounded-lg bg-neutral-950` div — locate by that class string, not by line number). Match its **label/sample/note structure**, but use current token law for the surface, not its classes:

```tsx
              <div className="bg-popover mt-6 rounded-md border px-4 py-5">
                <span className="text-muted-foreground mb-3 block font-mono text-xs tracking-widest">
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.designSystemSemiMonoLabel',
                  )}
                </span>
                <p className="font-semimono text-lg tracking-tight tabular-nums md:text-2xl">
                  ses_8f3ab291 · 2026-07-30 14:22:07 · a1b2c3d
                </p>
                <p className="text-muted-foreground mt-4 text-xs">
                  {tHardcodedUi.raw(
                    'appHomeDesignSystemPage.designSystemSemiMonoNote',
                  )}
                </p>
              </div>
```

The specimen string is intentionally an ID, a timestamp and a short hash — exactly SemiMono's job — so the page demonstrates correct use rather than only describing it.

Three deliberate choices, from `.claude/skills/kortix-design-system/SKILL.md` and
`apps/web/.agents/skills/make-interfaces-feel-better/SKILL.md`:

- **`bg-popover rounded-md border px-4 py-5`** — the sanctioned panel. Panels are
  `rounded-md`; `rounded-lg` belongs to inputs via `variant="popover"`, and `rounded-xl`/
  `2xl` are banned on app containers. In-flow panels stay **flat** — border, no shadow;
  elevation is for overlays only.
- **`tabular-nums`** on the specimen line. It is columnar data (ID, timestamp, hash), which
  is exactly what tabular figures are for.
- **Do not copy the adjacent Mono specimen's `rounded-lg bg-neutral-950`.** That block
  predates the current token law and uses a raw palette colour. Matching it would propagate
  the violation; leave it alone but do not imitate it.

- [ ] **Step 5: Run the test and the i18n audit**

```bash
cd /Users/jay/root/kortix/suna-font/tests
E2E_BASE_URL=http://127.0.0.1:3100 pnpm exec playwright test \
  --config typography/playwright.config.ts --project chromium -g "SemiMono" --reporter=list
cd ../apps/web && pnpm i18n:audit
npx eslint "src/app/(public)/(marketing)/design-system/page.tsx"
```

Expected: SemiMono test passes; the i18n audit reports no missing keys for the two new ones; eslint clean.

- [ ] **Step 6: Screenshot the section for review**

```bash
cd /Users/jay/root/kortix/suna-font
node -e "
const pkg = require('./apps/web/node_modules/@playwright/test/index.js');
(async () => {
  const b = await pkg.chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await p.goto('http://127.0.0.1:3100/design-system#typography', { waitUntil: 'networkidle' });
  await p.locator('#typography').screenshot({ path: '/tmp/semimono-section.png' });
  console.log('wrote /tmp/semimono-section.png');
  await b.close();
})();
"
```

Show the screenshot to the operator before committing. It must look native beside the existing Mono specimen.

- [ ] **Step 7: Commit** (only when the operator confirms)

```bash
cd /Users/jay/root/kortix/suna-font
git add apps/web/src/app/"(public)"/"(marketing)"/design-system/page.tsx apps/web/translations tests/typography/roobert.spec.ts
git commit -m "feat(web): expose Roobert SemiMono as font-semimono

MONO=60 sits between the sans and the mono. It suits session IDs, hashes and
timestamps, where full monospace is too wide and the sans too loose.

Documented on /design-system with an ID/timestamp/hash specimen, and guarded by
a test asserting it stays proportional — MONO=60 is NOT monospaced, so it must
never be used for code or column-aligned tables."
```

- [ ] **Step 8: Update Linear**

Comment with the SemiMono test output and the `pnpm i18n:audit` result, attach
`/tmp/semimono-section.png`, then set the issue to `Done`.

---

## Task 6: Full local verification (spec Verification 1–6)

**Files:**

- **No files modified.** This task only runs checks and records evidence. Explicitly does NOT touch `tests/visual/__screenshots__/` — see C7.

**Linear:** issue `Verify locally across three engines and refresh visual baselines`. Set `In Progress` before Step 1. If any baseline pixel cannot be traced to this work, comment the diff and stop rather than accepting the snapshot.

- [ ] **Step 1: Run the whole typography suite across all three engines**

This is spec Verification step 6 and closes risk R3 for the shipped implementation, not just the fixture.

```bash
cd /Users/jay/root/kortix/suna-font/tests
E2E_BASE_URL=http://127.0.0.1:3100 pnpm test:typography
```

Expected: every test passes on chromium, firefox and webkit. Paste the real output.

If Firefox or WebKit fails **here** but passed the Task 1 fixture gate, the difference is app CSS, not descriptor support — debug the cascade rather than redesigning D2.

- [ ] **Step 2: Confirm the payload win**

```bash
cd /Users/jay/root/kortix/suna-font
git show --stat HEAD~4 -- apps/web/public/fonts/roobert 2>/dev/null | tail -8
du -ch apps/web/public/fonts/roobert/*.woff2 | tail -1
```

Expected: one file, ~300 KB, down from 528 KB across four — 43% smaller.

- [ ] **Step 3: Record the visual-baseline state — but do NOT refresh (C7)**

### C7 — the visual baselines are already stale and are not a gate for this PR

R6 as originally written told you to refresh the landing snapshots. **Do not.** Investigated
2026-07-30 and all three of these are measured facts:

1. **They are already ~26% stale against `main` itself.** Rendering the landing page from
   the primary checkout (`main`, no font changes) against the committed baseline gives a
   diff ratio of **0.2593**. This branch gives **0.2536**. Isolating just the font change
   (primary vs this worktree) gives **0.0971**. So most of the delta predates this work.
2. **The full-page baseline has the wrong height.** Expected 9927px, actual 11207px — on
   **both** `main` and this branch, with identical section count (11) and text length
   (10513). Fonts do not add 1280px of height; that is unrelated drift.
3. **No workflow gating PRs to `main` runs `test:visual`.** `qa-release.yml` triggers on
   PRs to `prod`; `qa-staging.yml` on pushes to `staging`. Both run `ubuntu-latest`, while
   the only committed baselines are `-chromium-darwin.png` — so CI would not match them
   anyway.

Refreshing here would silently absorb someone else's 26% drift into a font PR and take
credit for fixing a snapshot this work did not break. So: **run it, record the numbers as
evidence, change nothing.**

```bash
cd /Users/jay/root/kortix/suna-font/tests
E2E_BASE_URL=http://127.0.0.1:3100 pnpm test:visual 2>&1 | tail -20
```

Expected: 2 failed. Paste the ratios. Do **not** pass `--update-snapshots`, and do **not**
stage anything under `tests/visual/__screenshots__/`.

Then confirm you have not changed them:

```bash
cd /Users/jay/root/kortix/suna-font
git status --short tests/visual/
```

Expected: no output.

**Follow-up to file (not fix here):** landing visual baselines are stale against `main` and
exist only for `darwin` while CI runs `linux`. Worth its own issue; out of scope for a font
change.

- [ ] **Step 4: Run the a11y suite (contrast can shift with weight)**

```bash
cd /Users/jay/root/kortix/suna-font/tests
E2E_BASE_URL=http://127.0.0.1:3100 pnpm test:a11y
```

Expected: passes. A heavier light weight only improves contrast, so a failure here means something unexpected.

- [ ] **Step 5: Production build**

The dev server uses Turbopack; the deployed artifact does not. Prove the `@font-face` URL and preload survive a real build.

```bash
cd /Users/jay/root/kortix/suna-font/apps/web && pnpm build 2>&1 | tail -30
grep -rn "RoobertCollectionVF" .next/static/css/*.css | head -3
ls -la .next/static/../../public/fonts/roobert/ 2>/dev/null || ls -la public/fonts/roobert/
```

Expected: build succeeds; the compiled CSS references `/fonts/roobert/RoobertCollectionVF.woff2`.

- [ ] **Step 6: Commit any baseline refresh** (only when the operator confirms)

```bash
cd /Users/jay/root/kortix/suna-font
git add tests/visual/__screenshots__
git commit -m "test(web): refresh landing visual baselines for the Roobert consolidation"
```

- [ ] **Step 7: Update Linear**

Comment with the full three-engine `pnpm test:typography` output, the a11y result, the
build result, and a one-line justification for every refreshed baseline pixel. Then set
the issue to `Done`.

---

## Task 7: Ship it (CLAUDE.md delivery path)

Local verification does not replace the deployed check, and a dev smoke test does not replace focused local tests. Both are required.

**Linear:** issue `Ship: PR, merge, Deploy Dev, verify on dev.kortix.com`. Set `In Progress` before Step 1. This issue and the Linear **project** both stay open until Step 5 passes against `dev.kortix.com` — merged is not shipped.

- [ ] **Step 1: Confirm the diff is scoped**

```bash
cd /Users/jay/root/kortix/suna-font
git status --short
git diff main --stat
```

`apps/web/src/lib/seo/content-timestamps.json` is pre-existing and unrelated — it must **not** appear in the diff. If it does, unstage it.

- [ ] **Step 2: Push and open the PR**

```bash
cd /Users/jay/root/kortix/suna-font
git push -u origin font
gh pr create --base main --title "Serve Roobert from one variable font and fix monospace alignment" --body "$(cat <<'EOF'
## Summary

Replaces the four Roobert `.woff2` files in `apps/web` (528 KB, up to 4 requests) with the foundry's own three-axis `RoobertCollectionVF.woff2` (300 KB, 1 request) — 43% smaller. Four `@font-face` rules share one `src` and pin their axes with the `font-variation-settings` descriptor, so the binary downloads once.

Fixes three things along the way:

- **Monospace alignment was broken in production.** `->` `<-` (`calt`) and `tt` `ff` `ffi` (`liga`) collapsed monospace cells, so `getAttribute->off` rendered three cells short and any column-aligned code or diff went ragged. `font-variant-ligatures: none` fixes all five; disabling `calt` alone fixes only the arrows.
- **The weight ladder was a lie.** The CSS declared `100 900` while the `wght` axis is `300–900`, so `font-thin` and `font-extralight` silently rendered as Light 300. All ten names now map onto the real axis and render distinctly. `400`–`800` are unchanged, so no shipped UI shifts.
- **Display-only stylistic sets leaked into code.** `ss03/ss04/ss09/ss14` swap `E F L y : ; ?` — and `:` and `;` are everywhere in TypeScript. They are now reset for `code`/`pre`/`.font-mono`, keeping only a slashed zero. `ss10` is deleted outright: it targets `?` and `ss09` already won, so it never did anything.

Also adds `font-semimono` (`MONO=60`) for IDs, hashes and timestamps, documented on `/design-system`.

The licence forbids modifying the binary, so nothing was subsetted or re-generated — this adopts a file the foundry already ships.

## Test plan

- `pnpm test:typography` — passes on Chromium, Firefox and WebKit. Covers the alignment regression (five 17-character lines must measure equal width), the single-download assertion, the ten-step weight ladder, the stylistic-set reset, and that SemiMono stays proportional.
- `pnpm test:visual` — landing baselines refreshed; every changed pixel traced to this work.
- `pnpm test:a11y` — passes.
- `pnpm build` — succeeds; compiled CSS references `/fonts/roobert/RoobertCollectionVF.woff2`.
- Verified in the browser: exactly 1 `woff2` request, preloaded with `crossorigin`.
EOF
)"
```

Do **not** put a Linear URL, a Claude Code footer, or a session link in the PR body —
the repo rule is that the description carries only the summary and test plan. Link the
other direction instead: after the PR exists, add it to the Linear issue via
`save_issue` `links: [{ url: "<pr url>", title: "PR: Roobert single-file font" }]`.

- [ ] **Step 3: Wait for required checks, then merge**

```bash
cd /Users/jay/root/kortix/suna-font
gh pr checks --watch
gh pr merge --squash
```

Do not stop at opening the PR. Do not leave finished work on a branch.

- [ ] **Step 4: Follow Deploy Dev to completion**

```bash
gh run list --workflow "Deploy Dev" --limit 3
gh run watch <run-id>
```

Confirm the deployed artifact contains the merged SHA. A successful `/health` response is **not** deployment proof. If a newer push cancelled or superseded the run, check that its path filters still rebuilt `apps/web`; dispatch the workflow manually if a component was skipped.

- [ ] **Step 5: Re-verify the user-visible behavior on dev**

```bash
cd /Users/jay/root/kortix/suna-font/tests
E2E_BASE_URL=https://dev.kortix.com pnpm test:typography
```

Expected: the same passes against the deployed site on all three engines. This is the deployed half of the CLAUDE.md requirement and it is not optional.

Then confirm the payload on the real host:

```bash
curl -sI https://dev.kortix.com/fonts/roobert/RoobertCollectionVF.woff2 | grep -i "content-length\|cache-control\|HTTP/"
```

Expected: `200`, `content-length` ~300000, `cache-control: public, max-age=31536000, immutable`.

- [ ] **Step 6: Close out Linear**

Only now, with the deployed evidence in hand:

1. Comment on the ship issue with the PR number, the merge SHA, the Deploy Dev run ID,
  the deployed-SHA evidence, the dev `pnpm test:typography` output, and the `curl -sI`
   headers. Set it to `Done`.
2. Set the project `Roobert Single-File Font` to `Completed`.
3. Leave the `Decide the tenth weight token name` issue `Done` if it was answered. If
  Jay never answered and Task 4 shipped under the recommended `font-heavy`, say so in
   a comment rather than closing it silently.
4. If R1 (licence tier) is still unanswered, open a follow-up issue in the `Jay` team —
  `Confirm Displaay licence covers self-hosted webfonts` — at `Backlog`, and note in
   its description that this is pre-existing exposure, not something this work
   introduced.
5. Open a `Backlog` follow-up for the deferred `apps/mobile` consolidation
  (~150 Roobert files, `RoobertCollectionVF` already present, adds Expo/NativeWind
   loading risk).

- [ ] **Step 7: Report**

Record in the final response, per the CLAUDE.md communication standard:

1. PR number and merge SHA.
2. Deploy Dev run ID and the deployed SHA evidence.
3. The exact `pnpm test:typography` output against `https://dev.kortix.com`.
4. Before/after payload: 528 KB / 4 requests → 300 KB / 1 request.
5. The Linear project URL and the final state of all 8 issues.
6. Anything still unverified, in one line each — including R1 (licence tier) if Jay has not answered.

---

## Open items to raise with Jay

Resolve 1 before Task 4. The rest do not block.

1. **The tenth weight token's name (C3).** Tailwind has no `font-950`. Recommendation: `font-heavy` → `wght 900`, matching Roobert's own instance name at 900. **Blocks Task 4.** Tracked as the Urgent issue created in Task 0 Step 4, assigned to Jay.
2. **Licence tier (spec R1).** Does the Displaay licence cover self-hosted webfonts? Pre-existing exposure — the four current files are already served from `public/`, and this change does not increase it. Worth confirming, does not block.
3. `**apps/mobile` follow-up.** It carries ~150 Roobert files and already has `RoobertCollectionVF`. The same consolidation is a larger win but adds Expo/NativeWind loading risk. Deferred by decision; track separately.
4. **Adopting `font-semimono` at real call sites.** 680 `font-mono` usages keep working unchanged. Migrating specific ID/hash/timestamp sites is a later taste-driven pass, explicitly out of scope here.

---

## Self-review

**Spec coverage:**


| Spec item                                      | Task                                                     |
| ---------------------------------------------- | -------------------------------------------------------- |
| D1 ship one file                               | Task 2 Step 1                                            |
| D2 four families, one `src`                    | Task 2 Steps 2–3; verified Task 1                        |
| D2 explicit preload                            | Task 2 Step 4                                            |
| D2 stale comment at `layout.tsx:190`           | Task 2 Step 4                                            |
| D3 ten-step weight ladder                      | Task 4 (blocked on C3)                                   |
| D4 mono ligature + feature settings            | Task 3 Steps 3–4 (**relocated to element level per C1**) |
| D5 sans keeps `ss03/04/09/14`, drops `ss10`    | Task 3 Step 4                                            |
| D6 `font-semimono` token                       | Task 2 Step 3; documented Task 5                         |
| F8 licence — no modification                   | Global Constraints; binary copied byte-for-byte          |
| R2 bare `pre`/`code` audit                     | Task 3 Step 1, third test                                |
| R3 cross-browser                               | Task 1 (gate) + Task 6 Step 1                            |
| R4 preload assertion                           | Task 2 Step 8; Task 3 test suite                         |
| R5 weight remap audit                          | Task 4 Step 5 (scoped to 3 files)                        |
| Verification 1 network                         | Task 2 Step 8                                            |
| Verification 2 axis assertion                  | Task 1 Step 4                                            |
| Verification 3 alignment regression, automated | Task 3 Step 1                                            |
| Verification 4 weight ladder                   | Task 4 Step 1                                            |
| Verification 5 visual diff                     | Task 6 Step 3                                            |
| Verification 6 cross-browser                   | Task 6 Step 1                                            |
| Verification 7 deployed                        | Task 7 Steps 4–5                                         |
| Files-this-touches list                        | Section C                                                |
| Progress tracked in Linear (`Jay` team)        | Section D + Task 0; per-task transitions in Tasks 1–7    |


Two spec items are deliberately **not** implemented as written, both documented in Section B with measurements: D4/D5 move from `@font-face` to element level (C1), and D3's `950` becomes a named token (C3).

**Placeholder scan:** no TBDs. Every code step carries the literal CSS, TSX, or test body. Every command is runnable as written. The one unresolved value — the tenth weight token's name — is called out as a blocking decision with a recommendation rather than left as a gap.

**Type consistency:** family strings `'Roobert'`, `'Roobert Mono'`, `'Roobert SemiMono'` are identical in Task 1's fixture, Task 2's `@font-face` rules, and every assertion in Tasks 3–5. Token names `--font-sans`, `--font-mono`, `--font-semimono`, `--font-weight-`* match between Task 2, Task 4, and the tests. Test file paths (`tests/typography/roobert.spec.ts`, `tests/typography/descriptor-support.spec.ts`) and the `test:typography` script name are consistent across Tasks 1, 3, 4, 5, 6, 7. `LINES_17` entries are each exactly 17 characters — verified by count.