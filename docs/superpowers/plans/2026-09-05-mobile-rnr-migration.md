# apps/mobile → React Native Reusables migration — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every forked UI primitive in `apps/mobile` with unmodified React Native Reusables components, themed by a single token source transcribed from `apps/web/src/app/globals.css`.

**Architecture:** `components/ui/` becomes RNR registry output only (32 files, mechanically diffable against the public registry JSON). Kortix-specific components move to `components/kortix/` and are rebuilt on RNR primitives. All 251 feature files are then migrated off raw React Native primitives and hex literals onto RNR components and token classes.

**Tech Stack:** Expo SDK 54, React Native 0.81.5, NativeWind 4.2.1, Tailwind 3.4.14, `@rn-primitives/*` 1.2.x, `@react-native-reusables/cli` 0.7.1, `@gorhom/bottom-sheet`, bun test.

**Spec:** `docs/superpowers/specs/2026-09-05-mobile-rnr-migration-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Working directory is `/Users/jay/root/kortix/suna-mobile/apps/mobile`.** The Bash tool resets cwd between calls — every command must `cd` explicitly or use absolute paths.
- **Branch is `revamp/mobile-ui`.** Do not create a branch or worktree.
- **Use `pnpm dlx`, never `npx`, for the RNR CLI.** `npx` fails with `npm error code EOVERRIDE` because `package.json` overrides `react-native-worklets@0.6.0` against a direct dependency of `0.5.1`.
- **Never run `@react-native-reusables/cli init`.** It scaffolds a new Expo project and destroys this app.
- **Do not commit and do not open a PR unless Jay asks.** Stage and report.
- **Never merge to `main`.**
- **Do not touch** `apps/web`, `packages/sdk`, `apps/api`, or `packages/shared`.
- **Do not upgrade** Expo, React Native, or Tailwind. Mobile stays Tailwind `3.4.14`; NativeWind 4 does not support Tailwind v4.
- **Never fork an RNR component in place.** Extend via a variant or a wrapper in `components/kortix/`, and record it in `apps/mobile/scratchpad/rnr-fork-delta.md`.
- **No `dark:` prefixes for color.** Tokens invert via `.dark:root` in `global.css`.
- **No new bespoke primitive.** If you are writing `cva(...)` for something RNR ships, stop.
- **Do not boot Expo, a simulator, or a device.** Verification is static only.
- **zsh does not word-split unquoted variables.** `for d in $DIRS` iterates once over the whole string. Write literal lists or use arrays.
- **`doctor` is informational, not a gate.** Its three findings on this repo are false positives (see spec §2.3). Do not rewrite `babel.config.js` to satisfy it.
- **Frozen baselines:** `tsc --noEmit` = 47 errors (45 mobile, 2 `packages/shared`). `bun test` = 72 pass / 0 fail / 18 files. Hex = 2,569. `TouchableOpacity` = 72 files. Missing tokens = 30.

---

# Milestone 1 — Install RNR and capture the fork

**Deliverable:** `components/ui/` holds 32 unmodified RNR files; every behavior the fork added is recorded with a decision.

### Task 1: Freeze the baselines

**Files:**
- Create: `apps/mobile/scratchpad/tsc-baseline.txt`
- Create: `apps/mobile/scratchpad/metrics-baseline.md`

**Interfaces:**
- Produces: `scratchpad/tsc-baseline.txt` — the frozen 47-error list consumed by every later gate-6 check.

- [ ] **Step 1: Record the typecheck baseline**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
mkdir -p scratchpad
npx tsc --noEmit 2>&1 | grep -E "^[^ ].*\(.*\): error" > scratchpad/tsc-baseline.txt
wc -l < scratchpad/tsc-baseline.txt
```

Expected: `47`

- [ ] **Step 2: Record every invariant count**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
{
  echo "# Migration baselines — $(date +%F)"
  echo
  echo "tsc errors:            $(wc -l < scratchpad/tsc-baseline.txt)"
  echo "  apps/mobile:         $(grep -vc '^\.\./\.\./' scratchpad/tsc-baseline.txt)"
  echo "  packages/shared:     $(grep -c '^\.\./\.\./' scratchpad/tsc-baseline.txt)"
  echo "TouchableOpacity files: $(grep -rl 'TouchableOpacity' components/ app/ --include='*.tsx' | wc -l)"
  echo "hex occurrences:       $(grep -rEo '#[0-9a-fA-F]{6}' components/ app/ --include='*.tsx' | wc -l)"
  echo "components/ui files:   $(git ls-files components/ui | wc -l)"
  echo "gorhom direct imports: $(grep -rl '@gorhom/bottom-sheet' components/ app/ --include='*.tsx' | wc -l)"
} > scratchpad/metrics-baseline.md
cat scratchpad/metrics-baseline.md
```

Expected: tsc 47 / 45 / 2, TouchableOpacity 72, hex 2569, ui files 53, gorhom 61.

- [ ] **Step 3: Confirm the test suite is green before any change**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile && bun test 2>&1 | tail -5
```

Expected: `72 pass`, `0 fail`, `Ran 72 tests across 18 files.`

### Task 2: Verify the CLI runs and no dependency is missing

Guards blocker B2: the CLI's dependency installer shells out to a **hardcoded** `npx expo install`, which would fail with `EOVERRIDE`. It is dormant only while zero dependencies are missing.

**Files:** none modified.

- [ ] **Step 1: Prove `npx` is broken and `pnpm dlx` is not**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
npx @react-native-reusables/cli@latest doctor 2>&1 | tail -3
```

Expected: `npm error code EOVERRIDE`. This confirms the blocker is still live.

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
pnpm dlx @react-native-reusables/cli@latest doctor 2>&1 | tail -15
```

Expected: runs, reporting Missing Files (Theme, Utils) and Babel Config. **All three are false positives — take no action on them.**

- [ ] **Step 2: Assert all 23 registry dependencies are already installed**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
node -e "
const p=require('./package.json'); const d={...p.dependencies,...p.devDependencies};
const need=['accordion','alert-dialog','aspect-ratio','avatar','checkbox','collapsible','context-menu','dialog','dropdown-menu','hover-card','label','menubar','popover','progress','radio-group','select','separator','slot','switch','tabs','toggle','toggle-group','tooltip'];
const missing=need.filter(n=>!d['@rn-primitives/'+n]);
console.log('needed:',need.length,'missing:',missing.length,missing);
if(missing.length) { console.error('STOP: install these with pnpm BEFORE running add, or the CLI hits hardcoded npx'); process.exit(1); }
"
```

Expected: `needed: 23 missing: 0 []`, exit 0.

If this exits 1, install the missing packages with `pnpm add` from `apps/mobile` **before** proceeding. Do not let the CLI install them.

### Task 3: Capture the fork delta offline, before overwriting anything

The RNR registry is plain HTTP JSON, so the exact `add --all` output is knowable without running a destructive command.

**Files:**
- Create: `apps/mobile/scratchpad/registry/*.json` (32 files, gitignored working data)
- Create: `apps/mobile/scratchpad/rnr-fork-delta.md`

**Interfaces:**
- Produces: `scratchpad/rnr-fork-delta.md` — the decision record every later task cites when it drops or re-expresses a fork variant.

- [ ] **Step 1: Fetch all 32 registry entries**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
mkdir -p scratchpad/registry && cd scratchpad/registry
for c in accordion alert-dialog alert aspect-ratio avatar badge button card checkbox \
         collapsible context-menu dialog dropdown-menu hover-card icon input label menubar \
         native-only-animated-view popover progress radio-group select separator skeleton \
         switch tabs text textarea toggle-group toggle tooltip; do
  curl -sL -o "$c.json" "https://reactnativereusables.com/r/nativewind/$c.json" &
done
wait
ls *.json | wc -l
for f in *.json; do head -c1 "$f" | grep -q '{' || echo "BAD $f"; done
```

Expected: `32`, and no `BAD` lines.

- [ ] **Step 2: Extract stock component source for diffing**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile/scratchpad/registry
mkdir -p stock
python3 - <<'EOF'
import json, glob, os, re
for p in glob.glob('*.json'):
    j = json.load(open(p))
    for f in j.get('files', []):
        base = os.path.basename(f['path'])
        c = f['content']
        # shadcn rewrites registry aliases to this project's components.json aliases
        c = c.replace('@/registry/nativewind/components/ui', '@/components/ui')
        c = c.replace('@/registry/nativewind/lib/utils', '@/lib/utils')
        open(os.path.join('stock', base), 'w').write(c)
print('stock files:', len(os.listdir('stock')))
EOF
```

Expected: `stock files: 32`

- [ ] **Step 3: Diff every forked file against stock**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
for f in scratchpad/registry/stock/*.tsx; do
  b=$(basename "$f")
  if [ -f "components/ui/$b" ]; then
    n=$(diff -u "components/ui/$b" "$f" | grep -c '^[+-]' || true)
    echo "$b  diff_lines=$n"
  else
    echo "$b  NEW (not present locally)"
  fi
done | sort -t= -k2 -rn
```

Expected: `avatar.tsx`, `menubar.tsx`, `skeleton.tsx` report `NEW`. `badge.tsx` and `button.tsx` report the largest diffs.

- [ ] **Step 4: Write the decision record**

Create `apps/mobile/scratchpad/rnr-fork-delta.md`. For every file with a non-zero diff, record the variants/props/behaviors the fork added and one decision each: **drop**, **re-express with tokens**, or **keep as documented extension**.

Seed it with these verified facts and decisions:

```markdown
# RNR fork delta — decisions

Captured 2026-09-05 before `add --all`, by diffing `components/ui/*` against
`https://reactnativereusables.com/r/nativewind/<name>.json`.

## badge.tsx — 450 lines, 148 variants, 106 hex literals
Stock: 4 variants (default, secondary, destructive, outline), 0 hex.
Real usage: 4 call sites app-wide.
  - components/billing/GlobalUpgradeSheet.tsx:122  variant="secondary"  (stock)
  - components/session/ProjectMoreSheet.tsx:55     <Badge>              (stock default)
  - components/pages/AgentsPage.tsx:159,160        <Badge label= icon= isDark= />  (fork API)
DECISION: drop all 148 fork variants. 146 are unreferenced.
DECISION: AgentsPage's label/icon/isDark API has no stock equivalent —
  rewrite those 2 call sites as `<Badge variant="secondary"><Icon .../><Text>…</Text></Badge>`.
  Task 22 owns this.

## button.tsx — 13 variants vs stock 6; default radius rounded-full vs stock rounded-md
Fork-only variants: secondary-outline, accent, card, inverted, white, black, transparent.
Real usage of fork-only variants: `transparent` × 2. All others: 0 call sites.
DECISION: drop accent, card, inverted, white, black, secondary-outline (0 refs).
DECISION: `transparent` → replace the 2 call sites with `variant="ghost"`. Task 20 owns this.
DECISION: radius — stock `rounded-md`. The fork's `rounded-full` is a visual
  change at 29 call sites. Flag for Jay in the M1 report; do not silently keep it.

## icon.tsx — behavior change, 406 call sites / 119 files
Stock reads TextClassContext so icons inherit their parent's text color:
    className={cn('text-foreground', textClass, className)}
Fork omits `textClass`, so icons are always `text-foreground`.
DECISION: take stock. It is the correct behavior (an icon inside a filled
  button should not stay dark). Landed on its own step (Task 5) so it can be
  reverted independently.

## sheet.tsx — no RNR equivalent
RNR ships no bottom sheet. 61 files import @gorhom/bottom-sheet directly.
DECISION (Jay, 2026-09-05): keep gorhom. Move to components/kortix/sheet.tsx as
  the SOLE gorhom call site; route the 61 direct importers through it.
  components/ui/ stays 100% RNR.
```

- [ ] **Step 5: Ignore the working registry data**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -q '^scratchpad/registry/' .gitignore || echo 'scratchpad/registry/' >> .gitignore
tail -2 .gitignore
```

### Task 4: Remove the case-colliding `Avatar.tsx`

The repo is on a case-insensitive filesystem. `components/ui/Avatar.tsx` and RNR's `avatar.tsx` are one path locally and two files on Linux CI. **Only this one file collides** — verified: RNR ships no `searchbar`, `sheetinput`, `shimmertext`, `threadavatar`, `kortixlogo`, `offlinebanner`, or `stopicon`.

**Files:**
- Delete: `components/ui/Avatar.tsx` (182 lines, 6 external refs)

- [ ] **Step 1: Record the current consumers before deleting**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -rn "ui/Avatar\|from '@/components/ui'" components/ app/ --include='*.tsx' | grep -i avatar
```

Expected: 6 files. Save this list — Task 17 repoints them.

- [ ] **Step 2: Delete it explicitly through git**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
git rm components/ui/Avatar.tsx
git ls-files components/ui | grep -i avatar
```

Expected: no output. If `Avatar.tsx` still appears, the index still holds the capitalized path — re-run `git rm --cached components/ui/Avatar.tsx`.

### Task 5: Install all 30 RNR components

**Files:**
- Modify: all 32 files under `components/ui/`

- [ ] **Step 1: Run the installer**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
pnpm dlx @react-native-reusables/cli@latest add --all --overwrite --yes 2>&1 | tail -40
```

If it fails, re-run with `--log-level all` and read the inner `shadcn` invocation. Do **not** fall back to `npx`.

- [ ] **Step 2: Verify the inventory is exactly 32 lowercase files**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
git add -A components/ui
git ls-files components/ui | sort
git ls-files components/ui | wc -l
git ls-files components/ui | grep -E '/[A-Z]' && echo "FAIL: capitalized file survives" || echo "OK: all lowercase"
```

Expected: 32 lowercase `.tsx` paths plus `index.ts` (deleted in Task 6). `skeleton.tsx`, `menubar.tsx`, `avatar.tsx` present.

- [ ] **Step 3: Confirm both patch-package patches still apply**

A failed `html-entities` patch reproduces the known worklet crash.

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
ls patches/
npx patch-package --error-on-fail 2>&1 | tail -10
```

Expected: both `@expensify+react-native-live-markdown+0.1.317` and `html-entities+2.5.3` apply cleanly.

- [ ] **Step 4: Verify each installed file matches its registry source**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
for f in scratchpad/registry/stock/*.tsx; do
  b=$(basename "$f")
  diff -q "components/ui/$b" "$f" >/dev/null 2>&1 || echo "DIFFERS: $b"
done
```

Any `DIFFERS` line must be explainable by shadcn's alias rewriting. Investigate anything else — it means `add` did not overwrite.

- [ ] **Step 5: Record the icon behavior change**

`icon.tsx` now reads `TextClassContext`. This changes icon color inheritance at 406 call sites. Confirm the new file has it:

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -n "TextClassContext" components/ui/icon.tsx
```

Expected: an import and a `React.useContext(TextClassContext)` line.

### Task 6: Delete the barrel and repoint its consumers

`components/ui/index.ts` re-exports 11 of 52 files. It is a hand-maintained file inside a directory RNR regenerates — `add --all` would clobber it on every future run. Direct imports are the single convention.

**Files:**
- Delete: `components/ui/index.ts`
- Modify: every file importing `from '@/components/ui'`

**Interfaces:**
- Consumes: Task 3's `rnr-fork-delta.md` for the `Toast` / `ToastType` type decision.
- Produces: a `components/ui/` with no non-RNR file, making gate 1 a clean equality check.

- [ ] **Step 1: List every barrel consumer**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -rn "from '@/components/ui'" components/ app/ lib/ hooks/ --include='*.tsx' --include='*.ts'
```

- [ ] **Step 2: Rewrite each to a direct path**

For each hit, replace the barrel import with direct imports. Example:

```tsx
// before
import { Button, Text, Icon } from '@/components/ui';

// after
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
```

`Avatar`, `SearchBar`, `KortixLoader`, `ToastProvider`, `useToast`, `Toast`, and `ToastType` move to their new homes in M3 — for now point them at their current paths and let Task 12 and Task 13 move them.

- [ ] **Step 3: Delete the barrel**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
git rm components/ui/index.ts
grep -rn "from '@/components/ui'" components/ app/ lib/ hooks/ --include='*.tsx' --include='*.ts' | wc -l
```

Expected: `0`

- [ ] **Step 4: Run the M1 gate set**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
bun test 2>&1 | tail -4
npx tsc --noEmit 2>&1 | grep -E "^[^ ].*\(.*\): error" > /tmp/tsc-m1.txt; wc -l < /tmp/tsc-m1.txt
diff <(sed 's/(.*//' scratchpad/tsc-baseline.txt | sort -u) <(sed 's/(.*//' /tmp/tsc-m1.txt | sort -u)
```

`bun test` must stay `72 pass / 0 fail`. The `diff` shows which files entered or left the error set. Files *leaving* is good. Any file *entering* must be fixed before M1 closes.

- [ ] **Step 5: Report, do not commit**

Report to Jay: the 32-file inventory, the fork-delta decisions, the `button` radius question (`rounded-full` → `rounded-md`), and the icon color-inheritance change. **Stage only.**

---

# Milestone 2 — One token source

**Deliverable:** `global.css` is the only definition of color; `THEME` / `NAV_THEME` derive from it; `lib/theme-colors.ts` is gone.

### Task 7: Port the 11 missing semantic tokens

**Files:**
- Modify: `apps/mobile/global.css`

**Interfaces:**
- Produces: `--surface`, `--pane`, `--hover`, `--active`, `--focus-ring`, `--foreground-strong`, `--foreground-weak`, `--border-width`, `--terminal-fg`, `--terminal-surface`, `--terminal-border` in both `:root` and `.dark:root`.

- [ ] **Step 1: Read the web values**

```bash
cd /Users/jay/root/kortix/suna-mobile
grep -nE '\-\-(surface|pane|hover|active|focus-ring|foreground-strong|foreground-weak|border-width|terminal-fg|terminal-surface|terminal-border):' apps/web/src/app/globals.css
```

- [ ] **Step 2: Transcribe oklch → HSL, preserving the comment convention**

Every line in mobile `global.css` carries the web oklch original in a trailing comment. Match it exactly. Add to `:root` and to `.dark:root`:

```css
    --surface: 0 0% 99.1%; /* oklch(0.9911 0 0) */
    --hover: 0 0% 0% / 0.045; /* oklch(0 0 0 / 0.045) */
    --active: 0 0% 0% / 0.075; /* oklch(0 0 0 / 0.075) */
```

and in `.dark:root`:

```css
    --surface: 0 0% 19.13%; /* oklch(0.1913 0 0) */
    --hover: 0 0% 100% / 0.06; /* oklch(1 0 0 / 0.06) */
    --active: 0 0% 100% / 0.1; /* oklch(1 0 0 / 0.1) */
```

Derive `--pane`, `--focus-ring`, `--foreground-strong`, `--foreground-weak`, `--border-width`, `--terminal-fg`, `--terminal-surface`, `--terminal-border` the same way from the values Step 1 printed.

- [ ] **Step 3: Register the new color tokens in Tailwind**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -n "colors:" -A 40 tailwind.config.js | head -50
```

Add each new token to `theme.extend.colors` in the same `hsl(var(--token))` form the existing tokens use, so `bg-surface` / `text-foreground-weak` compile.

- [ ] **Step 4: Verify parity improved from 30 missing to 19**

```bash
cd /Users/jay/root/kortix/suna-mobile
WEB=$(grep -oE '^[[:space:]]+--[a-z0-9-]+:' apps/web/src/app/globals.css | tr -d ' :' \
  | grep -vE '^--(color|animate|font|text|radius|shadow|ease|duration|spacing|breakpoint|container|leading|tracking|blur|perspective|aspect)-' | sort -u)
MOB=$(grep -oE '^[[:space:]]+--[a-z0-9-]+:' apps/mobile/global.css | tr -d ' :' | sort -u)
comm -23 <(echo "$WEB") <(echo "$MOB") | tee /tmp/missing.txt | tr '\n' ' '; echo
wc -l < /tmp/missing.txt
```

Expected: `19`, and every remaining entry is a `--kx-titlebar-*`, `--kx-desktop-zoom`, `--liquid-glass-*`, `--hit-area-*`, or `--spacing`.

- [ ] **Step 5: Write the skip justification**

DoD item 3 requires the 19 skipped tokens to be justified in writing, not just counted. Append to `apps/mobile/scratchpad/rnr-fork-delta.md`:

```markdown
## Web tokens deliberately NOT ported to mobile (19 of 30)

- `--kx-titlebar-content-left`, `--kx-titlebar-control-left`,
  `--kx-titlebar-control-size`, `--kx-titlebar-control-top`,
  `--kx-titlebar-controls-width`, `--kx-titlebar-inset`,
  `--kx-titlebar-lights-end` (7) — Electron desktop titlebar geometry. No
  titlebar exists on iOS or Android.
- `--kx-desktop-zoom` (1) — desktop zoom factor. No analogue on mobile.
- `--liquid-glass-bg`, `--liquid-glass-bg-hover`, `--liquid-glass-blur`,
  `--liquid-glass-highlight`, `--liquid-glass-saturate`,
  `--liquid-glass-shadow` (6) — backdrop-filter effects. React Native has no
  backdrop-filter; the equivalent is a native blur view, which these values do
  not describe.
- `--hit-area-t`, `--hit-area-b`, `--hit-area-l`, `--hit-area-r` (4) — defined
  as Tailwind v4 `--spacing(--value(number) * -1)` function calls. Tailwind
  v3.4.14 has no `--spacing()` function, so these are not transcribable.
  Mobile hit areas use `hitSlop` instead.
- `--spacing` (1) — see decision D1. Mobile keeps stock Tailwind spacing.

11 ported + 19 skipped = 30. Verified by gate 5.
```

### Task 8: Derive `THEME` and `NAV_THEME` from `global.css`

`NAV_THEME.light.primary` and `NAV_THEME.dark.primary` are both `#2E90FA` — a blue defined by no token in either app.

**Files:**
- Modify: `lib/utils/theme.ts`

**Interfaces:**
- Consumes: the token values written in Task 7.
- Produces: `THEME.light` / `THEME.dark` / `NAV_THEME` with values identical to `global.css`, and zero hex literals.

- [ ] **Step 1: Write a test that pins the values to `global.css`**

Create `lib/utils/theme.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NAV_THEME, THEME } from './theme';

const css = readFileSync(join(__dirname, '../../global.css'), 'utf8');

function token(scope: ':root' | '.dark:root', name: string): string {
  const block = css.split(scope)[1].split('}')[0];
  const m = block.match(new RegExp(`--${name}:\\s*([^;/]+)`));
  if (!m) throw new Error(`token --${name} not found in ${scope}`);
  return `hsl(${m[1].trim()})`;
}

describe('THEME derives from global.css', () => {
  it('light background matches --background', () => {
    expect(THEME.light.background).toBe(token(':root', 'background'));
  });
  it('light primary matches --primary', () => {
    expect(THEME.light.primary).toBe(token(':root', 'primary'));
  });
  it('dark background matches --background', () => {
    expect(THEME.dark.background).toBe(token('.dark:root', 'background'));
  });
});

describe('NAV_THEME carries no untokened color', () => {
  it('contains no hex literals', () => {
    const all = JSON.stringify(NAV_THEME);
    expect(all).not.toMatch(/#[0-9a-fA-F]{6}/);
  });
  it('primary is the token primary, not #2E90FA', () => {
    expect(NAV_THEME.light.colors.primary).toBe(THEME.light.primary);
    expect(NAV_THEME.dark.colors.primary).toBe(THEME.dark.primary);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile && bun test lib/utils/theme.test.ts 2>&1 | tail -20
```

Expected: FAIL. `THEME.light.background` is `hsl(0 0% 96%)` but `--background` is `0 0% 100%`; `NAV_THEME` contains `#2E90FA`.

- [ ] **Step 3: Rewrite `lib/utils/theme.ts`**

```ts
import { DarkTheme, DefaultTheme, type Theme } from '@react-navigation/native';

/**
 * Every value here is a transcription of the matching token in global.css.
 * global.css is the single source of color — see
 * docs/superpowers/specs/2026-09-05-mobile-rnr-migration-design.md §5.5.
 * Do not introduce a value that has no token. Do not write a hex literal.
 */
export const THEME = {
  light: {
    background: 'hsl(0 0% 100%)',        // --background
    foreground: 'hsl(180 0% 3.9%)',      // --foreground
    card: 'hsl(0 0% 95.4%)',             // --card
    cardForeground: 'hsl(180 0% 3.9%)',  // --card-foreground
    popover: 'hsl(0 0% 100%)',           // --popover
    popoverForeground: 'hsl(180 0% 3.9%)', // --popover-foreground
    primary: 'hsl(180 0% 9%)',           // --primary
    primaryForeground: 'hsl(60 0% 98%)', // --primary-foreground
    secondary: 'hsl(0 0% 96.1%)',        // --secondary
    secondaryForeground: 'hsl(180 0% 9%)', // --secondary-foreground
    muted: 'hsl(0 0% 96.1%)',            // --muted
    mutedForeground: 'hsl(0 0% 45.1%)',  // --muted-foreground
    accent: 'hsl(0 0% 96.1%)',           // --accent
    accentForeground: 'hsl(180 0% 9%)',  // --accent-foreground
    destructive: 'hsl(357.2 100% 45.3%)', // --destructive
    border: 'hsl(120 0% 89.8%)',         // --border
    input: 'hsl(0 0% 94.9%)',            // --input
    ring: 'hsl(0 0% 63.1%)',             // --ring
    radius: '0.625rem',                  // --radius
  },
  dark: {
    background: 'hsl(180 0% 3.9%)',      // --background
    foreground: 'hsl(60 0% 98%)',        // --foreground
    card: 'hsl(180 0% 9%)',              // --card
    cardForeground: 'hsl(60 0% 98%)',    // --card-foreground
    popover: 'hsl(180 0% 9%)',           // --popover
    popoverForeground: 'hsl(60 0% 98%)', // --popover-foreground
    primary: 'hsl(120 0% 89.8%)',        // --primary
    primaryForeground: 'hsl(180 0% 9%)', // --primary-foreground
    secondary: 'hsl(0 0% 14.9%)',        // --secondary
    secondaryForeground: 'hsl(60 0% 98%)', // --secondary-foreground
    muted: 'hsl(0 0% 14.9%)',            // --muted
    mutedForeground: 'hsl(0 0% 63.1%)',  // --muted-foreground
    accent: 'hsl(0 0% 14.9%)',           // --accent
    accentForeground: 'hsl(60 0% 98%)',  // --accent-foreground
    destructive: 'hsl(358.8 100% 69.6%)', // --destructive
    border: 'hsl(240 4% 15.9%)',         // --border
    input: 'hsl(0 0% 14.9%)',            // --input
    ring: 'hsl(0 0% 45.1%)',             // --ring
    radius: '0.625rem',                  // --radius
  },
} as const;

export const NAV_THEME: Record<'light' | 'dark', Theme> = {
  light: {
    ...DefaultTheme,
    colors: {
      background: THEME.light.background,
      border: THEME.light.border,
      card: THEME.light.card,
      notification: THEME.light.destructive,
      primary: THEME.light.primary,
      text: THEME.light.foreground,
    },
  },
  dark: {
    ...DarkTheme,
    colors: {
      background: THEME.dark.background,
      border: THEME.dark.border,
      card: THEME.dark.card,
      notification: THEME.dark.destructive,
      primary: THEME.dark.primary,
      text: THEME.dark.foreground,
    },
  },
};
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile && bun test lib/utils/theme.test.ts 2>&1 | tail -10
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Confirm `#2E90FA` is gone from the repo**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -rn "2E90FA" . --include='*.ts' --include='*.tsx' | grep -v node_modules | wc -l
```

Expected: `0`

### Task 9: Delete `lib/theme-colors.ts`

**Files:**
- Delete: `lib/theme-colors.ts`
- Modify: every consumer

**Interfaces:**
- Consumes: `THEME` from Task 8.
- Produces: `getSheetBg`, `getToggleTrackBg`, `getToggleActiveBg` re-homed or removed.

- [ ] **Step 1: Enumerate consumers**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -rn "theme-colors\|useThemeColors\|getSheetBg\|SHEET_BG_\|getToggleTrackBg\|getToggleActiveBg" \
  components/ app/ lib/ hooks/ --include='*.tsx' --include='*.ts' | grep -v "^lib/theme-colors.ts"
```

- [ ] **Step 2: Repoint each consumer**

- `useThemeColors().primary` → the `text-foreground` / `bg-primary` token class. Prefer deleting the JS read entirely.
- `getSheetBg(isDark)` → `THEME[isDark ? 'dark' : 'light'].popover`. Bottom sheets need a real JS color for gorhom's `backgroundStyle`; this is the one legitimate JS color read. It moves to `components/kortix/sheet.tsx` (Task 12) and stays private to it.
- `getToggleTrackBg` / `getToggleActiveBg` → token classes on the RNR `Switch` / `Toggle`.
- `accentColor()` / `accentSoft()` from `@/lib/ui/accent` → check whether they are still needed; if they return hex, they must read `THEME` instead.

- [ ] **Step 3: Delete the file**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
git rm lib/theme-colors.ts
grep -rn "theme-colors" components/ app/ lib/ hooks/ --include='*.tsx' --include='*.ts' | wc -l
```

Expected: `0`

### Task 10: Close M2 with the gate set

- [ ] **Step 1: Run every gate**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
echo "--- tests ---";  bun test 2>&1 | tail -4
echo "--- tsc ---";    npx tsc --noEmit 2>&1 | grep -E "^[^ ].*\(.*\): error" > /tmp/tsc-m2.txt; wc -l < /tmp/tsc-m2.txt
diff <(sed 's/(.*//' scratchpad/tsc-baseline.txt | sort -u) <(sed 's/(.*//' /tmp/tsc-m2.txt | sort -u)
echo "--- hex ---";    grep -rEo "#[0-9a-fA-F]{6}" components/ app/ --include='*.tsx' | wc -l
```

Expected: tests green; tsc ≤ 47 with no new files; hex down from 2,569 by roughly the 493 that lived in `components/ui/`.

- [ ] **Step 2: Report, do not commit.**

---

# Milestone 3 — Purge `components/ui/`

**Deliverable:** `components/ui/` is exactly 32 RNR files. Kortix components live in `components/kortix/`, rebuilt on RNR primitives.

### Task 11: Delete the six truly-dead files

All verified at 0 external references. `toast.tsx` is handled in Task 13 — **it is not dead**, its types are live through the barrel.

**Files:**
- Delete: `components/ui/modal.tsx` (458), `alert-modal.tsx` (382), `faded-scroll-view.tsx` (154), `safe-area-view.tsx` (22), `StopIcon.tsx` (38)

- [ ] **Step 1: Re-verify each is unreferenced — do not trust the list**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
for f in modal alert-modal faded-scroll-view safe-area-view StopIcon; do
  n=$(grep -rl "ui/$f'\|ui/$f\"" components/ app/ lib/ hooks/ --include='*.tsx' --include='*.ts' 2>/dev/null | grep -v "^components/ui/" | wc -l | tr -d ' ')
  echo "$f: $n refs"
done
```

Expected: all `0`. **If any is non-zero, stop and migrate that consumer first.**

- [ ] **Step 2: Delete**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
git rm components/ui/modal.tsx components/ui/alert-modal.tsx \
       components/ui/faded-scroll-view.tsx components/ui/safe-area-view.tsx \
       components/ui/StopIcon.tsx
bun test 2>&1 | tail -3
```

Expected: 1,054 lines gone, tests still green.

### Task 12: Move the Kortix-specific components

These have no RNR equivalent. They keep their behavior but move out so `components/ui/` is RNR-only.

**Files:**
- Move: 10 files from `components/ui/` to `components/kortix/`

**Interfaces:**
- Produces: `@/components/kortix/<name>` import paths consumed by M4 and M5.

- [ ] **Step 1: Create the directory and move each file**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
mkdir -p components/kortix
for f in selectable-markdown kortix-loader KortixLogo sheet animated-toggle-icon \
         ShimmerText OfflineBanner composer ThreadAvatar; do
  git mv "components/ui/$f.tsx" "components/kortix/$f.tsx"
done
ls components/kortix/
```

(`toast-provider.tsx` moves in Task 13, after its types are resolved.)

- [ ] **Step 2: Repoint every importer**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -rln "components/ui/\(selectable-markdown\|kortix-loader\|KortixLogo\|sheet\|animated-toggle-icon\|ShimmerText\|OfflineBanner\|composer\|ThreadAvatar\)" \
  components/ app/ lib/ hooks/ --include='*.tsx' --include='*.ts' \
  | xargs sed -i '' -E 's|components/ui/(selectable-markdown\|kortix-loader\|KortixLogo\|sheet\|animated-toggle-icon\|ShimmerText\|OfflineBanner\|composer\|ThreadAvatar)|components/kortix/\1|g'
grep -rn "components/ui/\(selectable-markdown\|kortix-loader\|KortixLogo\|sheet\|animated-toggle-icon\|ShimmerText\|OfflineBanner\|composer\|ThreadAvatar\)" components/ app/ lib/ hooks/ | wc -l
```

Expected: `0`

- [ ] **Step 3: Make `sheet.tsx` the sole gorhom call site (decision D2)**

`components/kortix/sheet.tsx` absorbs the `getSheetBg` logic deleted in Task 9:

```tsx
import { THEME } from '@/lib/utils/theme';
// ...
const backgroundColor = THEME[isDark ? 'dark' : 'light'].popover;
```

Then migrate the 61 direct `@gorhom/bottom-sheet` importers to use `<Sheet>`:

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -rl "@gorhom/bottom-sheet" components/ app/ --include='*.tsx' | grep -v "components/kortix/sheet.tsx"
```

Work through that list. This is the largest single item in M3 — treat each file as its own reviewable change.

- [ ] **Step 4: Verify the invariant**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -rl "@gorhom/bottom-sheet" components/ app/ --include='*.tsx' | wc -l
```

Expected: `1` — only `components/kortix/sheet.tsx`.

- [ ] **Step 5: Fix the two baseline tsc errors in `animated-toggle-icon.tsx`**

It is being rewritten anyway. Target: baseline 47 → 45.

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep "animated-toggle-icon" scratchpad/tsc-baseline.txt
```

Fix both, then re-run `npx tsc --noEmit` and confirm they are gone.

### Task 13: Resolve the `toast.tsx` type dependency, then delete it

`toast.tsx` has 0 path imports but `components/ui/index.ts` re-exported its `Toast` / `ToastType` types, and `toast-provider.tsx` (8 external refs, 10 consuming files) depends on them. **Order matters — reversing it breaks the build.**

**Files:**
- Move: `components/ui/toast-provider.tsx` → `components/kortix/toast-provider.tsx`
- Delete: `components/ui/toast.tsx`

- [ ] **Step 1: Read both files and locate the type declarations**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -n "export type\|export interface\|^type \|^interface " components/ui/toast.tsx
cat components/ui/toast-provider.tsx
```

- [ ] **Step 2: Move the provider**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
git mv components/ui/toast-provider.tsx components/kortix/toast-provider.tsx
```

- [ ] **Step 3: Inline the `Toast` / `ToastType` declarations into the provider**

Copy the type declarations out of `toast.tsx` into `components/kortix/toast-provider.tsx` and export them from there. The provider becomes self-contained.

- [ ] **Step 4: Repoint the 10 consumers**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -rln "components/ui/toast" components/ app/ lib/ hooks/ --include='*.tsx' --include='*.ts' \
  | xargs sed -i '' 's|components/ui/toast-provider|components/kortix/toast-provider|g; s|components/ui/toast|components/kortix/toast-provider|g'
grep -rn "components/ui/toast" components/ app/ lib/ hooks/ | wc -l
```

Expected: `0`

- [ ] **Step 5: Now delete `toast.tsx` and prove nothing broke**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
git rm components/ui/toast.tsx
bun test 2>&1 | tail -3
npx tsc --noEmit 2>&1 | grep -c "toast"
```

Expected: tests green, `0` toast-related type errors.

### Task 14: Rebuild the six layout components as thin RNR compositions

These are app-level layout, not primitives. They keep layout classes and nothing else — no color, no size, no weight.

**Files:**
- Move + rewrite: `page-header.tsx` (33 refs), `page-content.tsx` (33), `search-list-header.tsx` (10), `SearchBar.tsx` (4), `SheetInput.tsx` (3), `list-row.tsx` (6) → `components/kortix/`

**Interfaces:**
- Consumes: RNR `Text`, `View`, `Separator`, `Input`, `Card` from `components/ui/`.
- Produces: same exported component names and props, so the 89 call sites do not change shape.

- [ ] **Step 1: Move them**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
for f in page-header page-content search-list-header SearchBar SheetInput list-row; do
  git mv "components/ui/$f.tsx" "components/kortix/$f.tsx"
done
```

- [ ] **Step 2: Repoint importers**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -rln "components/ui/\(page-header\|page-content\|search-list-header\|SearchBar\|SheetInput\|list-row\)" \
  components/ app/ --include='*.tsx' \
  | xargs sed -i '' -E 's|components/ui/(page-header\|page-content\|search-list-header\|SearchBar\|SheetInput\|list-row)|components/kortix/\1|g'
grep -rn "components/ui/\(page-header\|page-content\|search-list-header\|SearchBar\|SheetInput\|list-row\)" components/ app/ | wc -l
```

Expected: `0`

- [ ] **Step 3: Rewrite each on RNR primitives**

Keep the public props identical. Replace internals:

- `SearchBar.tsx` and `SheetInput.tsx` → wrap RNR `Input` from `@/components/ui/input`; delete any local `TextInput` styling.
- `page-header.tsx` → RNR `Text` variants + `View` + `Separator`. Every size/weight/color becomes a `Text` variant or a token class.
- `page-content.tsx` → `View` with layout classes only.
- `search-list-header.tsx` → RNR `Input` + `Text`.
- `list-row.tsx` → RNR `Card` + `Separator`.

- [ ] **Step 4: Prove no hex survives in these six**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -nE "#[0-9a-fA-F]{6}" components/kortix/page-header.tsx components/kortix/page-content.tsx \
  components/kortix/search-list-header.tsx components/kortix/SearchBar.tsx \
  components/kortix/SheetInput.tsx components/kortix/list-row.tsx | wc -l
```

Expected: `0`

### Task 15: Close M3 — assert the `components/ui/` invariant

- [ ] **Step 1: Gate 1 — exactly 32 RNR files**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
git add -A
git ls-files components/ui | sort
git ls-files components/ui | wc -l
git ls-files components/ui | grep -E '/[A-Z]|index\.ts' && echo "FAIL" || echo "OK: RNR-only"
```

Expected: `32`, all lowercase `.tsx`, no `index.ts`.

- [ ] **Step 2: Gate 7 — no file differs from its registry source**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
for f in scratchpad/registry/stock/*.tsx; do
  b=$(basename "$f")
  diff -q "components/ui/$b" "$f" >/dev/null 2>&1 || echo "DIFFERS: $b"
done
```

Every `DIFFERS` line must have an entry in `rnr-fork-delta.md`.

- [ ] **Step 3: Gate 4 — no orphaned imports**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -rn "ui/modal\|ui/alert-modal\|ui/toast'\|ui/Avatar\|ui/SearchBar\|ui/sheet\|ui/faded-scroll-view\|ui/safe-area-view\|ui/StopIcon\|ui/page-header\|ui/page-content\|ui/list-row\|ui/SheetInput\|ui/search-list-header\|from '@/components/ui'" \
  app/ components/ lib/ hooks/ | wc -l
```

Expected: `0`

- [ ] **Step 4: Gates 2, 3, 6**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
echo "TouchableOpacity: $(grep -rl 'TouchableOpacity' components/ app/ --include='*.tsx' | wc -l)"
echo "hex:              $(grep -rEo '#[0-9a-fA-F]{6}' components/ app/ --include='*.tsx' | wc -l)"
bun test 2>&1 | tail -3
npx tsc --noEmit 2>&1 | grep -E "^[^ ].*\(.*\): error" > /tmp/tsc-m3.txt; wc -l < /tmp/tsc-m3.txt
diff <(sed 's/(.*//' scratchpad/tsc-baseline.txt | sort -u) <(sed 's/(.*//' /tmp/tsc-m3.txt | sort -u)
```

Expected: hex ≈ 2,076 (2,569 − 493); tsc ≤ 45; tests green.

- [ ] **Step 5: Report, do not commit.**

---

# Milestone 4 — Feature wave A (87 files, 17 `TouchableOpacity`, 377 hex)

**Deliverable:** the lower-risk half of the app is built only from RNR primitives and tokens.

Wave A runs first because it holds the shared and low-level consumers, letting the conventions settle on 87 files before the 26,533-line `components/pages` is touched.

**Per-file procedure — apply to every task in M4 and M5:**

1. Replace `TouchableOpacity` / `Pressable` styled as a button → `<Button variant= size=>` from `@/components/ui/button`.
2. Replace raw `Text` from `react-native` → `<Text variant=>` from `@/components/ui/text`.
3. Replace raw `TextInput` → `<Input>` / `<Textarea>`.
4. Replace raw `Switch` / `Modal` → RNR `Switch` / `Dialog`.
5. Replace every hex and `rgba()` literal with a token class (`bg-card`, `text-muted-foreground`, `border-border`, `bg-surface`, `bg-hover`…).
6. Apply the `rnr-fork-delta.md` decision for any fork-only variant.
7. Delete now-dead local style objects and `StyleSheet.create` blocks.
8. No `dark:` prefix for color — tokens invert automatically.

**Per-task verification — run after every task:**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
D=components/<dir>
echo "TouchableOpacity: $(grep -rl 'TouchableOpacity' $D --include='*.tsx' | wc -l)"   # target 0
echo "hex:              $(grep -rEo '#[0-9a-fA-F]{6}' $D --include='*.tsx' | wc -l)"   # target 0
bun test 2>&1 | tail -3
npx tsc --noEmit 2>&1 | grep -E "^[^ ].*\(.*\): error" | wc -l
```

### Task 16: `components/settings` — 24 files, 1 `TouchableOpacity`, 141 hex

Largest wave-A directory; highest hex density. Do it first so the token vocabulary is exercised early.

- [ ] **Step 1: List the work**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -rl "TouchableOpacity" components/settings --include='*.tsx'
grep -rcE "#[0-9a-fA-F]{6}" components/settings --include='*.tsx' | sort -t: -k2 -rn | head
```

- [ ] **Step 2: Apply the per-file procedure to each file.**
- [ ] **Step 3: Run the per-task verification. Both counts must reach 0.**

### Task 17: `components/accounts` — 10 files, 10 `TouchableOpacity`, 52 hex

Every file in this directory uses `TouchableOpacity`. Also repoints the 6 `Avatar` consumers identified in Task 4 Step 1 onto RNR `avatar`.

- [ ] **Step 1: Repoint the Avatar consumers**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -rn "Avatar" components/accounts --include='*.tsx'
```

Replace the bespoke `Avatar` API with RNR's `<Avatar><AvatarImage /><AvatarFallback /></Avatar>` composition from `@/components/ui/avatar`.

- [ ] **Step 2: Apply the per-file procedure to all 10 files.**
- [ ] **Step 3: Run the per-task verification. Both counts must reach 0.**

### Task 18: `components/billing` — 8 files, 0 `TouchableOpacity`, 36 hex

Includes `GlobalUpgradeSheet.tsx:122`, one of the four `<Badge>` call sites (already stock `secondary` — no change needed to the variant).

- [ ] **Step 1: Apply the per-file procedure.**
- [ ] **Step 2: Run the per-task verification. hex must reach 0.**

### Task 19: `components/agents` — 6 files, 2 `TouchableOpacity`, 14 hex

- [ ] **Step 1: Apply the per-file procedure.**
- [ ] **Step 2: Run the per-task verification.**

### Task 20: `components/menu`, `components/models`, `components/shared` — 15 files, 2 `TouchableOpacity`, 40 hex

Also retires the `Button` `transparent` variant. Per `rnr-fork-delta.md`, its 2 call sites become `variant="ghost"`.

- [ ] **Step 1: Find and convert the `transparent` call sites**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -rn 'variant="transparent"' components/ app/ --include='*.tsx'
```

Replace each with `variant="ghost"`.

- [ ] **Step 2: Apply the per-file procedure to all 15 files.**
- [ ] **Step 3: Verify the variant is gone**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -rn 'variant="transparent"\|variant="accent"\|variant="card"\|variant="inverted"\|variant="white"\|variant="black"\|variant="secondary-outline"' components/ app/ --include='*.tsx' | wc -l
```

Expected: `0`

### Task 21: `components/auth`, `threads`, `status`, `projects`, `home` — 16 files, 2 `TouchableOpacity`, 47 hex

- [ ] **Step 1: Apply the per-file procedure.**
- [ ] **Step 2: Run the per-task verification.**

### Task 22: `components/icons`, `loading`, `navigation`, `animations`, `providers`, `diff`, `updates` — 8 files, 0 `TouchableOpacity`, 49 hex

`components/updates/UpdateDialog.tsx` carries 6 of the 45 baseline tsc errors — the single largest cluster. Fix them here.

- [ ] **Step 1: Read the baseline errors for this directory**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep "components/updates" scratchpad/tsc-baseline.txt
```

- [ ] **Step 2: Apply the per-file procedure and fix the 6 errors.**
- [ ] **Step 3: Verify**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
npx tsc --noEmit 2>&1 | grep -c "components/updates"
```

Expected: `0`

### Task 23: Close M4

- [ ] **Step 1: Assert wave A is clean**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
T=0; H=0
for d in accounts agents auth billing menu models settings shared threads status projects home icons loading navigation animations providers diff updates; do
  t=$(grep -rl TouchableOpacity components/$d --include='*.tsx' 2>/dev/null | wc -l | tr -d ' ')
  h=$(grep -rEo "#[0-9a-fA-F]{6}" components/$d --include='*.tsx' 2>/dev/null | wc -l | tr -d ' ')
  T=$((T+t)); H=$((H+h))
  [ "$t" != "0" ] || [ "$h" != "0" ] && echo "  components/$d  TO=$t hex=$h"
done
echo "WAVE A TOTAL: TouchableOpacity=$T (was 17)  hex=$H (was 377)"
```

Expected: both `0`. Any non-zero line names the file still to fix.

- [ ] **Step 2: Full gate set + report. Do not commit.**

---

# Milestone 5 — Feature wave B (112 files, 53 `TouchableOpacity`, 1,699 hex)

**Deliverable:** the heaviest surfaces are migrated. 66% of the app's hex and 74% of its `TouchableOpacity` live here.

Use the **per-file procedure** (8 steps) and the **per-task verification** block
defined at the top of Milestone 4 — scroll up to the M4 header. They are defined
once and apply unchanged to every task in M4 and M5.

### Task 24: `components/pages` part 1 — the 10 highest-hex files

`components/pages` is 34 files / 26,533 lines / 28 `TouchableOpacity` / 848 hex. Split it so each task stays reviewable.

- [ ] **Step 1: Rank the files**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -rcE "#[0-9a-fA-F]{6}" components/pages --include='*.tsx' | sort -t: -k2 -rn | head -10
```

Expected top entries: `ProjectDetailPage.tsx` (41), `ConnectorsPage.tsx` (37), `ChangesPage.tsx` (31), `MemoryPage.tsx` (26), `SandboxPage.tsx` (24), `SecretsNavPage.tsx` (22), `WebhooksPage.tsx` (20).

- [ ] **Step 2: Migrate those 10 files with the per-file procedure.**

`AgentsPage.tsx` is in this group and owns the two fork-API `<Badge label= icon= isDark= />` call sites at lines 159–160. Per `rnr-fork-delta.md`, rewrite them as:

```tsx
<Badge variant="secondary">
  <Icon as={Star} className="size-3" />
  <Text>Default</Text>
</Badge>
```

- [ ] **Step 3: Verify no `<Badge>` uses the fork API**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -rn "<Badge[^>]*label=" components/ app/ --include='*.tsx' | wc -l
```

Expected: `0`

- [ ] **Step 4: Per-task verification on the 10 files.**

### Task 25: `components/pages` part 2 — remaining 24 files

- [ ] **Step 1: Apply the per-file procedure.**
- [ ] **Step 2: Fix the baseline tsc errors in this directory**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep "components/pages" scratchpad/tsc-baseline.txt
```

`SecretsNavPage.tsx` (5), `TunnelPage.tsx` (3), `ApiKeysPage.tsx` (3), `UpdatesPage.tsx` (2), `TerminalPage.tsx` (2), `SSHPage.tsx` (2), `ScheduledTasksPage.tsx` (2), `AgentBrowserPage.tsx` (2), `BrowserPage.tsx` (1).

- [ ] **Step 3: Verify the whole directory**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
echo "TO:  $(grep -rl TouchableOpacity components/pages --include='*.tsx' | wc -l)"   # was 28
echo "hex: $(grep -rEo '#[0-9a-fA-F]{6}' components/pages --include='*.tsx' | wc -l)" # was 848
```

Expected: both `0`.

### Task 26: `components/session` part 1 — `SessionTurn.tsx` and `SessionChatInput.tsx`

The two densest files in the app after `badge.tsx`: 78 and 53 hex literals.

- [ ] **Step 1: Apply the per-file procedure to both.**
- [ ] **Step 2: Verify**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -cE "#[0-9a-fA-F]{6}" components/session/SessionTurn.tsx components/session/SessionChatInput.tsx
```

Expected: `0` for both.

### Task 27: `components/session` part 2 — remaining 28 files

30 files / 16,245 lines / 16 `TouchableOpacity` / 443 hex total for the directory.

- [ ] **Step 1: Apply the per-file procedure.**
- [ ] **Step 2: Fix the 4 baseline tsc errors** in `UserMenuSheet.tsx`, `useMentions.ts`, `SessionErrorBanner.tsx`, `CommandPalette.tsx`.
- [ ] **Step 3: Verify the directory reaches 0 / 0.**

### Task 28: `components/triggers`, `workers`, `files` — 19 files, 3 `TouchableOpacity`, 302 hex

- [ ] **Step 1: Apply the per-file procedure.**
- [ ] **Step 2: Run the per-task verification.**

### Task 29: `app/` — 29 files, 6 `TouchableOpacity`, 106 hex

The Expo Router tree. `app/_layout.tsx` holds the `PortalHost` at line 664 and the `@rn-primitives/portal` import at line 21 — **do not disturb them**; RNR overlays depend on that host.

- [ ] **Step 1: Confirm the portal host survives**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -n "PortalHost\|@rn-primitives/portal" app/_layout.tsx
```

- [ ] **Step 2: Apply the per-file procedure to the 29 files.**
- [ ] **Step 3: Confirm the portal host still exists after editing, and verify.**

### Task 30: Close M5 — global invariants reach zero

- [ ] **Step 1: Gates 2 and 3 across the whole app**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
echo "TouchableOpacity files: $(grep -rl 'TouchableOpacity' components/ app/ --include='*.tsx' | wc -l)"   # was 72, target 0
echo "hex occurrences:        $(grep -rEo '#[0-9a-fA-F]{6}' components/ app/ --include='*.tsx' | wc -l)"   # was 2569
grep -rn "#[0-9a-fA-F]\{6\}" components/ app/ --include='*.tsx' | grep -v "hex-allowlist"
```

The final `grep` must print only allowlisted lines. Every surviving hex carries a `// hex-allowlist: <reason>` comment — brand SVG assets (`components/kortix/KortixLogo.tsx`) and fixed-palette hero surfaces.

- [ ] **Step 2: Full gate set + report. Do not commit.**

---

# Milestone 6 — Docs and final verification

**Deliverable:** `apps/mobile/CLAUDE.md` describes the real surface; every gate reported before → after.

### Task 31: Rewrite `apps/mobile/CLAUDE.md`

The current file mandates four components this migration deletes (`modal`, `alert-modal`, `faded-scroll-view`, `safe-area-view`) and documents a `button` variant list that no longer matches. **Wrong docs caused this drift; leaving them wrong guarantees it recurs.**

**Files:**
- Modify: `apps/mobile/CLAUDE.md`

- [ ] **Step 1: Delete the four dead rows from the primitives table**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -n "modal\|alert-modal\|faded-scroll-view\|safe-area-view" CLAUDE.md
```

- [ ] **Step 2: Rewrite the primitives table against the real 32**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
git ls-files components/ui | sort
git ls-files components/kortix | sort
```

Every row must name a file that exists. Add a `components/kortix/` section for the Kortix-specific components and the sheet wrapper.

- [ ] **Step 3: Replace the `Button` section with the stock variant list**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -n "variant:" -A 20 components/ui/button.tsx | head -30
```

Document exactly what stock ships. Delete the fork-variant list.

- [ ] **Step 4: Add the four standing rules this migration establishes**

```markdown
## Invariants (mechanically checked)

1. `components/ui/` contains ONLY React Native Reusables registry output — 32
   files, no barrel, no capitalized filenames. A file here that differs from
   `https://reactnativereusables.com/r/nativewind/<name>.json` is a bug. Never
   edit one; extend it in `components/kortix/` and record the reason in
   `scratchpad/rnr-fork-delta.md`.
2. `global.css` is the single source of color. Every token is a transcription of
   an `apps/web/src/app/globals.css` token with the oklch original in a trailing
   comment. No hex literal in component code outside a `// hex-allowlist:`
   comment. `THEME` / `NAV_THEME` in `lib/utils/theme.ts` derive from these
   values and are pinned by `lib/utils/theme.test.ts`.
3. **Mobile spacing intentionally diverges from web.** Web sets
   `--spacing: 0.23rem`, making its Tailwind scale 8% tighter than stock. Mobile
   uses STOCK Tailwind spacing, because the tighter scale pushes `p-2` / `p-3`
   touch targets below the 44pt HIG minimum. Do not mirror web's scale.
4. `@gorhom/bottom-sheet` has exactly one call site:
   `components/kortix/sheet.tsx`. RNR ships no bottom sheet, and converting to
   `dialog` would lose pan-down-to-dismiss, snap points, and keyboard-aware
   sizing. Use `<Sheet>`; never import gorhom directly.

## Tooling

- Use `pnpm dlx @react-native-reusables/cli@latest`, **never `npx`**. `npx`
  fails with `EOVERRIDE` because `package.json` overrides
  `react-native-worklets@0.6.0` against a direct dependency of `0.5.1`.
- **Never run `init`** — it scaffolds a new Expo project and destroys this app.
- `doctor` reports three findings on this repo (Theme, Utils, Babel Config).
  All three are **false positives**: no registry component imports `THEME`,
  `@/lib/utils` resolves via `lib/utils/index.ts`, and `babel.config.js:4`
  already has `nativewind/babel`. Do not "fix" them.
```

- [ ] **Step 5: Verify every path named in the doc exists**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
grep -oE '@/components/(ui|kortix)/[a-zA-Z-]+' CLAUDE.md | sort -u | sed 's|@/|./|' | while read p; do
  [ -f "$p.tsx" ] || echo "MISSING: $p"
done
```

Expected: no output.

### Task 32: Final verification — every gate, before and after

- [ ] **Step 1: Run all seven gates and capture real output**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
echo "=== GATE 1: components/ui is RNR-only ==="
git ls-files components/ui | sort; git ls-files components/ui | wc -l

echo "=== GATE 2: TouchableOpacity (was 72) ==="
grep -rl "TouchableOpacity" components/ app/ --include='*.tsx' | wc -l

echo "=== GATE 3: hex (was 2569) ==="
grep -rEo "#[0-9a-fA-F]{6}" components/ app/ --include='*.tsx' | wc -l
grep -rn "#[0-9a-fA-F]\{6\}" components/ app/ --include='*.tsx' | grep -vc "hex-allowlist"

echo "=== GATE 4: orphaned imports (target 0) ==="
grep -rn "ui/modal\|ui/alert-modal\|ui/toast'\|ui/Avatar\|ui/SearchBar\|ui/sheet\|ui/faded-scroll-view\|ui/safe-area-view\|ui/StopIcon\|ui/page-header\|ui/page-content\|ui/list-row\|ui/SheetInput\|ui/search-list-header\|from '@/components/ui'" app/ components/ lib/ hooks/ | wc -l

echo "=== GATE 6: tsc no-regression (baseline 47) ==="
npx tsc --noEmit 2>&1 | grep -E "^[^ ].*\(.*\): error" > /tmp/tsc-final.txt; wc -l < /tmp/tsc-final.txt
diff <(sed 's/(.*//' scratchpad/tsc-baseline.txt | sort -u) <(sed 's/(.*//' /tmp/tsc-final.txt | sort -u)

echo "=== TESTS (baseline 72 pass / 18 files) ==="
bun test 2>&1 | tail -4

echo "=== DOCTOR (informational only) ==="
pnpm dlx @react-native-reusables/cli@latest doctor 2>&1 | tail -12
```

- [ ] **Step 2: Gate 5 — token parity, from the repo root**

```bash
cd /Users/jay/root/kortix/suna-mobile
WEB=$(grep -oE '^[[:space:]]+--[a-z0-9-]+:' apps/web/src/app/globals.css | tr -d ' :' \
  | grep -vE '^--(color|animate|font|text|radius|shadow|ease|duration|spacing|breakpoint|container|leading|tracking|blur|perspective|aspect)-' | sort -u)
MOB=$(grep -oE '^[[:space:]]+--[a-z0-9-]+:' apps/mobile/global.css | tr -d ' :' | sort -u)
comm -23 <(echo "$WEB") <(echo "$MOB") | tee /tmp/missing-final.txt
wc -l < /tmp/missing-final.txt
```

Expected: `19`, all `--kx-titlebar-*`, `--kx-desktop-zoom`, `--liquid-glass-*`, `--hit-area-*`, `--spacing`.

- [ ] **Step 3: Gate 7 — no forked primitive**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
for f in scratchpad/registry/stock/*.tsx; do
  b=$(basename "$f")
  diff -q "components/ui/$b" "$f" >/dev/null 2>&1 || echo "DIFFERS: $b"
done
```

Every line must have an entry in `rnr-fork-delta.md`.

- [ ] **Step 4: Write the final report**

Give, for each gate, the before number, the after number, the exact command, and its real output. State explicitly anything left unverified and why. Per the standing rule, static gates only — no simulator, no device.

- [ ] **Step 5: Stage everything and stop.**

```bash
cd /Users/jay/root/kortix/suna-mobile/apps/mobile
git add -A
git status --short | head -40
git status --short | wc -l
```

**Do not commit. Do not open a PR. Do not merge.** Report to Jay and wait.
