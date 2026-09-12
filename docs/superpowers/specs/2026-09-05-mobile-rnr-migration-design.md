# apps/mobile → React Native Reusables migration — design

**Date:** 2026-09-05
**Branch:** `revamp/mobile-ui` (canonical; do not create another)
**Worktree:** `/Users/jay/root/kortix/suna-mobile`
**Scope:** `apps/mobile` only, plus read-only use of `apps/web/src/app/globals.css`

---

## 1. Problem

`apps/mobile` carries a drifted fork of React Native Reusables (RNR) and three
contradictory color sources. Three measured symptoms:

1. `components/ui/` holds 52 `.tsx` files / 7,109 lines. RNR's registry produces
   32 files. The surplus is fork drift plus bespoke code.
2. 2,569 hardcoded hex literals across `components/` and `app/`.
3. 72 files import `TouchableOpacity`, which `apps/mobile/CLAUDE.md` already bans.

The deeper problem, found during verification: **the primitives were never
adopted.** `<Badge>` has 4 call sites app-wide. `<Button>` has 29. Meanwhile
`@gorhom/bottom-sheet` is imported directly by 61 files, bypassing the
`sheet.tsx` wrapper that exists for that purpose. This is not a fork to unwind —
it is an adoption gap to close.

## 2. Verified ground truth

Measured 2026-09-05 on `revamp/mobile-ui`. Every number below has a command in
§9. **Seven premises in the originating task brief are wrong**; they are
corrected here and must not be re-derived from the brief.

### 2.1 Blockers

| # | Finding | Consequence |
| --- | --- | --- |
| B1 | `npx @react-native-reusables/cli@latest <cmd>` fails with `npm error code EOVERRIDE`. `apps/mobile/package.json` declares `overrides["react-native-worklets"] = "0.6.0"` while `dependencies["react-native-worklets"] = "0.5.1"`. npm refuses to run. | Every CLI invocation must use `pnpm dlx`, never `npx`. Verified: `pnpm dlx @react-native-reusables/cli@latest doctor` runs. |
| B2 | The CLI's internal dependency installer calls `runCommand2("npx", ["expo","install",...])` with a **hardcoded** `npx` — it does not use the detected runner. Any missing dependency re-triggers B1 from inside the CLI. | Dormant only because all 23 required `@rn-primitives/*` packages are already installed. Must be re-checked before `add`, never assumed. |

### 2.2 Corrections to the task brief

| Brief claims | Verified | Effect on plan |
| --- | --- | --- |
| RNR ships **32** `registry:ui` components | CLI's `--all` list is **30**. `icon` and `native-only-animated-view` arrive as *registryDependencies*, not `--all` entries. 30 names → **32 files**. | Target inventory is 32 files from 30 `add` names. |
| 8 files risk macOS case-collision | Only **`Avatar.tsx`** collides (RNR ships `avatar`). No RNR `searchbar`, `sheetinput`, `shimmertext`, `threadavatar`, `kortixlogo`, `offlinebanner`, or `stopicon` exists. | One `git rm`, not eight. |
| `toast.tsx` has 0 import sites — delete | 0 path-imports, but `components/ui/index.ts` re-exports its `Toast` / `ToastType` types, and `toast-provider.tsx` (8 external refs, consumed by 10 files) depends on them. | Deleting it blind breaks the build. Types must move first. |
| `badge.tsx` (450 lines, 148 variants) is the headline target | 4 `<Badge>` call sites app-wide. 1 uses stock `secondary`. 2 use a *different API* (`label` / `icon` / `isDark`) in `AgentsPage.tsx`. | Cheapest win. Only `AgentsPage.tsx` needs real work. |
| `tsc --noEmit` must be clean | Baseline is **47 errors** — 45 in `apps/mobile`, 2 in `packages/shared` (out of scope by the brief's own hard rules). | "Clean" is unsatisfiable. Gate is no-regression vs. 47. |
| Phase-6 hex gate reports 2,460 | That command (`grep` without `-o`) prints **1,311** — it counts *lines*, not occurrences. `-o` gives 2,463 in `components/`. | Gate command is fixed in §9. |
| `doctor` reports 3 real problems | All three are **false positives** for this repo. See §2.3. | Do not "fix" them. |

### 2.3 `doctor` output is advisory, not a gate

`pnpm dlx @react-native-reusables/cli@latest doctor` reports:

- **Missing Files: Theme** — RNR expects `lib/theme.ts`; this repo has
  `lib/utils/theme.ts`. **Zero RNR registry components import `THEME` or
  `lib/theme`** (verified across all 30 registry entries). Cannot break installs.
- **Missing Files: Utils** — RNR expects `lib/utils.ts`; this repo has
  `lib/utils/index.ts`, so `@/lib/utils` resolves correctly.
- **Babel Config misconfigured** — `babel.config.js:4` already contains
  `nativewind/babel`. The check looks for a different config shape.

**Rule: `doctor` is run for information. It is not a definition-of-done gate.**
Rewriting a working `babel.config.js` to satisfy a false positive is a
regression.

### 2.4 How the CLI actually works

`@react-native-reusables/cli@0.7.1` is a thin wrapper. It resolves each
component to `https://reactnativereusables.com/r/nativewind/<name>.json` and
shells out to `shadcn@latest add <urls...>`. Registry components import from
`@/registry/nativewind/...`; shadcn rewrites those to the aliases in
`components.json` (`@/components/ui`, `@/lib/utils`). Both aliases already
resolve in this repo.

Because the registry is plain HTTP JSON, **the exact output of `add --all` can
be diffed offline before running it** — this is how the fork delta is captured
in M1 without a destructive dry run.

### 2.5 Migration surface

| Group | Files | `TouchableOpacity` | hex literals |
| --- | ---: | ---: | ---: |
| `components/ui/` (deleted or replaced in M1–M3) | 52 | 2 | 493 |
| Wave A — `accounts, agents, auth, billing, menu, models, settings, shared, threads, status, projects, home, icons, loading, navigation, animations, providers, diff, updates` | 87 | 17 | 377 |
| Wave B — `pages, session, workers, triggers, files`, `app/` | 112 | 53 | 1,699 |
| **Total** | **251** | **72** | **2,569** |

Wave B carries 66% of the hex and 74% of the `TouchableOpacity` in 45% of the
files. `components/pages` alone is 26,533 lines.

### 2.6 Baselines (frozen)

- `npx tsc --noEmit` → **47 errors** (45 `apps/mobile`, 2 `packages/shared`).
- `bun test` → **72 pass / 0 fail across 18 files**. (The brief said 11 files.)
- Token parity → web has 70 semantic tokens, mobile 41; **30 web tokens missing
  in mobile**, 1 mobile-only (`--chrome-background`).

## 3. Objective

`apps/mobile` renders every primitive from **unmodified** RNR components, themed
entirely by design tokens transcribed from `apps/web/src/app/globals.css`.
`components/ui/` contains exactly RNR registry output. Zero forked primitives.
Zero hardcoded color in component code.

## 4. Decisions

Resolved with Jay on 2026-09-05. These are settled; do not reopen.

### D1 — Spacing: keep stock, document the divergence

Web sets `--spacing: 0.23rem`, making its Tailwind scale 8% tighter than stock.
Mobile keeps **stock Tailwind spacing**. `tailwind.config.js` is not given a
`spacing` theme key.

**Rationale:** an 8%-tighter scale pushes `p-2` / `p-3` touch targets below the
44pt minimum in Apple's HIG. Mirroring it would require a density re-check of
251 files for no user benefit on a phone.

**Obligation:** `apps/mobile/CLAUDE.md` must state that mobile spacing
intentionally diverges from web, and why. An undocumented divergence is how this
drift started.

### D2 — Bottom sheets: `@gorhom/bottom-sheet` stays, behind one wrapper

RNR ships no bottom-sheet primitive. Converting 61 files to RNR `dialog` would
lose pan-down-to-dismiss, snap points, backdrop drag, and keyboard-aware sizing
— the dominant mobile navigation idiom in this app.

`components/ui/sheet.tsx` moves to `components/kortix/sheet.tsx` and becomes the
**only** `@gorhom/bottom-sheet` call site. The 61 direct importers migrate to
route through it. `components/ui/` stays 100% RNR. The exception is recorded in
`apps/mobile/scratchpad/rnr-fork-delta.md` as "no RNR equivalent exists".

### D3 — Typecheck gate: no regression against a frozen 47

Baseline of 47 errors is committed to
`apps/mobile/scratchpad/tsc-baseline.txt` in M1.

- **Gate:** total ≤ 47 **and** no file enters the error set that was not in the
  baseline. Comparing counts alone is insufficient — fixing one error while
  introducing another would pass a count check.
- **Target:** 44. Three baseline errors sit in files this migration rewrites:
  `components/ui/animated-toggle-icon.tsx` (×2) and
  `components/ui/selectable-markdown.tsx` (×1).
- `packages/shared`'s 2 errors are out of scope and stay.

### D4 — Six milestones

M1 install + fork capture · M2 tokens · M3 `components/ui` purge ·
M4 feature wave A · M5 feature wave B · M6 docs + verification.

Each milestone ends in an independently reviewable, bisectable state. Wave A
runs before wave B because wave A holds the shared/low-level consumers and lets
the token and primitive conventions settle on 87 lower-risk files before the
26,533-line `components/pages` is touched.

## 5. Architecture

### 5.1 Target directory contract

```
components/ui/        ONLY RNR registry output. 32 files.
                      Byte-identical to `add --all` except deltas recorded
                      in rnr-fork-delta.md.
components/kortix/    Kortix-specific, no RNR equivalent. Built ON RNR
                      primitives + tokens. The only place a primitive may
                      be extended.
components/<feature>/ Feature components. Assembled only from the two
                      directories above. No local primitive, no hex.
```

The invariant that makes this durable: **a file in `components/ui/` that differs
from its registry JSON is a bug.** That is mechanically checkable (§9, gate 1)
in a way "please don't fork the button" never was.

### 5.2 `components/ui/` disposition — all 52 files

**Overwritten by `add --all` (29 present + 3 new = 32):**
`accordion, alert-dialog, alert, aspect-ratio, avatar*, badge, button, card,
checkbox, collapsible, context-menu, dialog, dropdown-menu, hover-card, icon,
input, label, menubar†, native-only-animated-view, popover, progress,
radio-group, select, separator, skeleton†, switch, tabs, text, textarea,
toggle-group, toggle, tooltip`

`*` replaces bespoke `Avatar.tsx` (182 lines, 6 refs) — the one case-collision.
`†` new to the app.

**Deleted — 0 external references (verified):**

| File | Lines | Refs |
| --- | ---: | ---: |
| `modal.tsx` | 458 | 0 |
| `alert-modal.tsx` | 382 | 0 |
| `faded-scroll-view.tsx` | 154 | 0 |
| `safe-area-view.tsx` | 22 | 0 |
| `StopIcon.tsx` | 38 | 0 |
| `toast.tsx` | 173 | 0 direct — **types first** (see §5.3) |

**Moved to `components/kortix/` — Kortix-specific, no RNR equivalent:**

| File | Lines | Refs | Note |
| --- | ---: | ---: | --- |
| `selectable-markdown.tsx` | 1,544 | 9 | largest file in the app |
| `kortix-loader.tsx` | 146 | 4 | |
| `KortixLogo.tsx` | 85 | 8 | brand SVG — hex allowlisted |
| `sheet.tsx` | 84 | 6 | D2: sole gorhom call site |
| `animated-toggle-icon.tsx` | 87 | 1 | 2 baseline tsc errors, fix here |
| `ShimmerText.tsx` | 73 | 2 | |
| `OfflineBanner.tsx` | 75 | 1 | |
| `composer.tsx` | 70 | 1 | |
| `toast-provider.tsx` | 54 | 8 | absorbs `toast.tsx` types |
| `ThreadAvatar.tsx` | 45 | 1 | composes RNR `avatar` |

**Rebuilt as thin RNR compositions, then moved to `components/kortix/`:**

| File | Lines | Refs | Rebuilt from |
| --- | ---: | ---: | --- |
| `page-header.tsx` | 135 | 33 | RNR `Text` + `View` + `Separator` |
| `page-content.tsx` | 38 | 33 | `View` + layout classes only |
| `search-list-header.tsx` | 108 | 10 | RNR `Input` + `Text` |
| `SearchBar.tsx` | 77 | 4 | RNR `Input` |
| `SheetInput.tsx` | 45 | 3 | RNR `Input` |
| `list-row.tsx` | 49 | 6 | RNR `Card` + `Separator` |

These are app-level layout, not primitives. They keep their own layout classes
and nothing else — no color, no size, no weight.

**Deleted outright:** `index.ts` (see §5.4).

### 5.3 `toast.tsx` — ordering constraint

`toast.tsx` looks dead (0 path imports) but is not. `components/ui/index.ts`
carries `export type { Toast, ToastType } from './toast'`, and
`toast-provider.tsx` — used by 10 files — consumes those types.

Required order: move the `Toast` / `ToastType` type declarations into
`components/kortix/toast-provider.tsx` → repoint the 10 consumers → **then**
`git rm components/ui/toast.tsx`. Reversing this breaks the build.

### 5.4 Import convention: direct imports, barrel deleted

`components/ui/index.ts` re-exports 11 of 52 files. Consumers import both
through it and directly — two conventions, neither complete.

**Decision: delete the barrel; every import is a direct path.**

Rationale: `add --all` regenerates `components/ui/*` and would clobber a
hand-maintained `index.ts` on every future run, reintroducing exactly the drift
this migration removes. A barrel is a file RNR does not own sitting in a
directory RNR must own. Direct imports also keep gate 1 (§9) a clean equality
check.

### 5.5 Token architecture

`global.css` is the single source of color. It is already correct in shape — it
carries HSL transcriptions with the web oklch original in a trailing comment on
each line. **Preserve that convention exactly.**

```
apps/web/src/app/globals.css   (Tailwind v4, oklch)   ← source of truth
        │  transcribe oklch → HSL, keep /* oklch(...) */ comment
        ▼
apps/mobile/global.css         (Tailwind v3 + NativeWind preset)
        │  single source
        ├─→ NativeWind utility classes  (all component styling)
        └─→ lib/utils/theme.ts  THEME / NAV_THEME  (React Navigation chrome only)
```

Three sources collapse to one:

| Source | Today | After |
| --- | --- | --- |
| `global.css` | correct, 41 tokens | **canonical**, 52 tokens |
| `lib/utils/theme.ts` `THEME` | independent palette (`hsl(0 0% 96%)` bg) | derived from `global.css` values |
| `lib/utils/theme.ts` `NAV_THEME` | raw hex, `primary: #2E90FA` — **a blue defined by no token in either app** | derived; `#2E90FA` deleted |
| `lib/theme-colors.ts` | `#121215`, `#F8F8F8`, `SHEET_BG_*` | **file deleted** |

**Mobile stays Tailwind v3.4.14.** NativeWind 4 does not support Tailwind v4.

**Tokens to port (11 of the 30 missing):** `--surface`, `--pane`, `--hover`,
`--active`, `--focus-ring`, `--foreground-strong`, `--foreground-weak`,
`--border-width`, `--terminal-fg`, `--terminal-surface`, `--terminal-border`.

**Tokens to skip (19), justified as desktop-only:** `--kx-titlebar-*` (7),
`--kx-desktop-zoom` (1), `--liquid-glass-*` (6), `--hit-area-*` (4) — all four
`--hit-area-*` values are Tailwind v4 `--spacing()` function calls with no v3
equivalent — and `--spacing` itself (1, per D1). 11 ported + 19 skipped = 30.

**Load-bearing, keep as-is:** the `--kortix-*` brand accents,
`--chrome-background`, and the `@layer utilities` Roobert font-weight mapping.
React Native cannot synthesize font weights from one file, so that mapping is
the only thing making `font-medium` render as Roobert-Medium. Removing it
silently flattens every weight in the app.

### 5.6 Behavior change: `Icon` inherits text color

The local `icon.tsx` and RNR's differ in one way that matters. RNR's reads
`TextClassContext`:

```tsx
const textClass = React.useContext(TextClassContext);
className={cn('text-foreground', textClass, className)}
```

The fork omits `textClass`. Overwriting means **icons inside a `<Button>` start
inheriting the button's text color** instead of always rendering
`text-foreground`. `<Icon>` has 406 call sites across 119 files — the app's
most-used primitive.

This is a correctness improvement (an icon in a dark-filled button should not
stay dark), but it is user-visible at 406 sites. It is called out here so the
change is intentional, and it is the reason M1 lands `icon.tsx` on its own
reviewable step.

## 6. Risks

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| B2 fires — CLI hits hardcoded `npx` for a missing dep | Low (0 missing today) | M1 step 1 re-verifies all 23 deps present *before* `add`. If any is missing, install it manually with `pnpm` first. |
| `add --all` clobbers a file with un-captured fork value | Medium | M1 captures the offline registry diff **before** running `add`. Registry is plain HTTP JSON — no destructive dry run needed. |
| Case-insensitive FS hides `Avatar.tsx` / `avatar.tsx` | High if unhandled | Explicit `git rm components/ui/Avatar.tsx`; verify with `git ls-files components/ui \| sort`. Only this one file collides. |
| `patch-package` patches fail after dependency change | Medium | Two patches (`@expensify+react-native-live-markdown+0.1.317`, `html-entities+2.5.3`). A failed `html-entities` patch reproduces the known worklet crash. Verify both after any install; restart Metro with `--clear`. |
| Icon color change (§5.6) regresses a screen | Medium | Isolated to its own M1 step so it can be reverted independently. |
| Wave B scope (1,699 hex, 53 `TouchableOpacity`, 26k lines) stalls | High | Split by directory into per-area tasks; each is independently bisectable. |
| Deleting the barrel breaks unseen importers | Low | Gate 4 (§9) greps for every deleted path before the milestone closes. |

## 7. Non-goals

- No Expo, React Native, or Tailwind upgrade.
- No Tailwind v4 on mobile (NativeWind 4 forbids it).
- No changes to `apps/web`, `packages/sdk`, `apps/api`.
- No fix for the 2 `packages/shared` tsc errors.
- No `init` — it scaffolds a new Expo project and would destroy this app.
- No new bespoke primitive. If `cva(...)` is being written for something RNR
  ships, stop.
- No `dark:` prefixes for color — tokens invert via `.dark:root`.

## 8. Testing strategy

Static gates only. **Do not boot Expo, a simulator, or a device.** (Per the
standing `no-browser-verification` rule and the task brief.)

- `npx tsc --noEmit` — diffed against the frozen baseline, not against zero.
- `bun test` — 72 tests / 18 files, must stay green.
- The six invariant gates in §9, each reported before → after.
- `pnpm dlx @react-native-reusables/cli@latest doctor` — informational (§2.3).

Every milestone re-runs the full gate set. A claim without its command and
output does not count as verified.

## 9. Verification gates

Run from `/Users/jay/root/kortix/suna-mobile/apps/mobile` unless noted.

**Gate 1 — `components/ui/` is exactly RNR output**

```bash
git ls-files components/ui | sort
# expect exactly 32 lowercase .tsx paths, no index.ts, no capitalized names
```

**Gate 2 — zero banned primitives** (before: 72)

```bash
grep -rl "TouchableOpacity" components/ app/ --include='*.tsx' | wc -l   # target 0
```

**Gate 3 — zero hardcoded color outside the allowlist** (before: 2,569)

Note `-o`: the brief's command omitted it and counted lines (1,311), not
occurrences.

```bash
grep -rEo "#[0-9a-fA-F]{6}" components/ app/ --include='*.tsx' | wc -l
```

Allowlist — each site carries a `// hex-allowlist: <reason>` comment:
brand SVG assets (`KortixLogo.tsx`) and fixed-palette hero surfaces.

**Gate 4 — no orphaned imports of deleted files** (target 0)

```bash
grep -rn "ui/modal\|ui/alert-modal\|ui/toast'\|ui/Avatar\|ui/SearchBar\|ui/sheet\|ui/faded-scroll-view\|ui/safe-area-view\|ui/StopIcon\|ui/page-header\|ui/page-content\|ui/list-row\|ui/SheetInput\|ui/search-list-header\|from '@/components/ui'" app/ components/ lib/ hooks/ | wc -l
```

**Gate 5 — token parity with web** (before: 30 missing; after: 19, all
justified desktop-only). Run from the **repo root**.

```bash
cd /Users/jay/root/kortix/suna-mobile
WEB=$(grep -oE '^[[:space:]]+--[a-z0-9-]+:' apps/web/src/app/globals.css | tr -d ' :' \
  | grep -vE '^--(color|animate|font|text|radius|shadow|ease|duration|spacing|breakpoint|container|leading|tracking|blur|perspective|aspect)-' | sort -u)
MOB=$(grep -oE '^[[:space:]]+--[a-z0-9-]+:' apps/mobile/global.css | tr -d ' :' | sort -u)
comm -23 <(echo "$WEB") <(echo "$MOB")
```

**Gate 6 — typecheck no-regression** (D3)

```bash
npx tsc --noEmit 2>&1 | grep -E "^[^ ].*\(.*\): error" > /tmp/tsc-now.txt
wc -l < /tmp/tsc-now.txt                                    # must be <= 47
diff <(sed 's/(.*//' scratchpad/tsc-baseline.txt | sort -u) \
     <(sed 's/(.*//' /tmp/tsc-now.txt | sort -u)            # no NEW files
```

**Gate 7 — no forked primitive**: every `components/ui/*.tsx` matches its
registry JSON, except deltas recorded in `rnr-fork-delta.md`.

```bash
# per component: compare local file to https://reactnativereusables.com/r/nativewind/<name>.json
```

## 10. Definition of done

1. `components/ui/` contains exactly 32 files, all RNR registry output; every
   difference is recorded in `apps/mobile/scratchpad/rnr-fork-delta.md`.
2. All 30 RNR components installed via 30 `add` names, including `skeleton` and
   `menubar`; `icon` and `native-only-animated-view` present as
   registryDependencies.
3. Every mobile color token is a transcription of an `apps/web` token with the
   oklch original in a trailing comment. 11 tokens ported, 19 skipped with
   written justification.
4. `lib/theme-colors.ts` deleted; `THEME` / `NAV_THEME` derive from `global.css`
   values; `#2E90FA` no longer appears in the repo.
5. Hex count in `components/` + `app/` is 0 outside the commented allowlist
   (from 2,569).
6. `TouchableOpacity` import count is 0 (from 72).
7. `bun test` green (72/18); `tsc` ≤ 47 with no new files vs. baseline.
8. `apps/mobile/CLAUDE.md` describes the RNR surface accurately, including D1's
   spacing divergence and D2's sheet exception.
9. Final report gives before/after for every gate in §9 with the command and its
   real output.

## 11. Hard rules

- **Do not commit and do not open a PR unless Jay asks.** Stage and report.
- **Never merge to `main`** — that needs Jay's explicit word on the merge itself.
- **Never fork an RNR component in place.** Extend via variant or wrapper in
  `components/kortix/`, and record it in `rnr-fork-delta.md`.
- **Always `pnpm dlx`, never `npx`,** for the RNR CLI (B1).
- **Never run `init`.**
- Do not touch `apps/web`, `packages/sdk`, `apps/api`.
- If a decision would lose user-visible behavior and the code cannot resolve it,
  finish everything that does not depend on it, then ask — with the specific
  file and the two options.
