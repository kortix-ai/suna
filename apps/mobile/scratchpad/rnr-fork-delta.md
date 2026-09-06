# RNR fork delta — decisions

Captured 2026-09-05 before `add --all`, by diffing `components/ui/*` against
`https://reactnativereusables.com/r/nativewind/<name>.json`.

Method: `scratchpad/registry/*.json` (32 files fetched) →
`scratchpad/registry/stock/*.tsx` (extracted, with `@/registry/nativewind/...`
rewritten to `@/components/ui/...` and `@/lib/utils`) →
`diff -u components/ui/<f> scratchpad/registry/stock/<f>` for each of the 30
present files, saved under `scratchpad/registry/diffs/*.diff`.

Real-usage counts below come from `grep -rl "from '@/components/ui/<name>'"
--include='*.tsx' . ` plus a JSX `<Component` sweep, run 2026-09-05 against
this checkout. `components/ui/index.ts` (the barrel) re-exports `Avatar`,
`Badge`, `Button`, `Icon`, `Input`, `Text`, `SearchBar`,
`NativeOnlyAnimatedView`; 12 files import through it — only
`GlobalUpgradeSheet.tsx` among them touches `Badge`.

## badge.tsx — 450 lines, fork adds a large color/status variant palette
Stock: 4 variants (default, secondary, destructive, outline), 0 hex/named-color
literals beyond the 4 semantic tokens.
Real usage: 2 real call sites, both stock-compatible.
  - components/billing/GlobalUpgradeSheet.tsx:122  variant="secondary"  (stock, imported via barrel `../ui`)
  - components/session/ProjectMoreSheet.tsx:55     <Badge>              (stock default, direct import)
DECISION: drop all fork-only variants (`oliveGreen`, `rosePink`, `success`,
  `badgeSuccess`, `update`, `warning`, `info`, `terminal`, `reset`, `opened`,
  `closed`, `blue`, `loading`, `red`, `orange`, `amber`, `yellow`, `lime`,
  `green`, `emerald`, and further ones past line 60 — none referenced anywhere
  in `components/` or `app/`). Take stock's badge.tsx wholesale.

### Correction to the seed (verified 2026-09-05)
`components/pages/AgentsPage.tsx:198` defines its **own local** `function
Badge({ label, icon, isDark })` — it does **not** import
`@/components/ui/badge`. Its two call sites (lines 159–160) are calls to that
local function, not to the RNR-forked component. **The `add --all --overwrite`
on `components/ui/badge.tsx` does not touch AgentsPage.tsx at all** — there is
no import relationship. The seed's "AgentsPage's label/icon/isDark API has no
stock equivalent — rewrite those 2 call sites" item is not a consequence of
this migration; it is a same-name-different-component situation worth a
separate cleanup ticket (rename the local helper to avoid confusion), but it
is not blocking or required by Task 3/4.
Net effect: badge.tsx overwrite is a clean, zero-call-site-breaking swap.

## button.tsx — 13 variants vs stock 6; default radius rounded-full vs stock rounded-md; extra `content` variant system
Fork-only variants: secondary-outline, accent, card, inverted, white, black, transparent.
Fork also adds a `content` variant axis (`fit`, `fit-lg`, `fit-sm`, `fit-icon`,
`full`) and a `getTextClassName()` helper that scrapes `text-*` tokens out of
the Button's own `className` and feeds them into `TextClassContext` (stock
just uses `buttonTextVariants({variant, size})` with no scraping).
Real usage of fork-only variants: `transparent` × **5** (all in
`app/auth/index.tsx`, lines 520, 523, 592, 625, 641 — verified by
`grep -rn 'variant="transparent"'`; the seed's "× 2" is stale, corrected here
to the real count). All other fork-only variants: 0 call sites.
`content=` variant: 0 call sites (`grep -rn 'content="fit'` / `content={` on
any `<Button` — no matches).
`getTextClassName` reliance: 0 call sites (no `<Button ... className="...text-...">`
found anywhere in `components/` or `app/`).
Total real `<Button` JSX usages app-wide: 29 (verified).
DECISION: drop accent, card, inverted, white, black, secondary-outline (0 refs).
DECISION: drop the `content` variant axis and `getTextClassName` helper (0 refs, both).
DECISION: `transparent` → replace the 5 call sites in `app/auth/index.tsx`
  with `variant="ghost"`. Task 20 owns this (brief's file/task ownership
  unchanged; only the reference count is corrected: 5, not 2).
DECISION: radius — stock `rounded-md`. The fork's `rounded-full` is a visual
  change at 29 call sites. Flag for Jay in the M1 report; do not silently keep it.

## icon.tsx — behavior change, ~115 files import it directly (seed said 406 call sites / 119 files; direct-import file count verified at 115, in the same range — barrel re-export adds a handful more indirect consumers)
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

## Avatar.tsx — 202 diff lines against stock avatar.tsx, NOT a duplicate (controller ruling R5)
Note on tooling: macOS's default case-insensitive filesystem (APFS) makes
`components/ui/avatar.tsx` and `components/ui/Avatar.tsx` the SAME inode
(verified: `stat -f "%i %N"` on both returns inode `40100092` for both paths).
Step 3's diff script therefore diffed stock's `avatar.tsx` against the real
`Avatar.tsx`, not against a nonexistent file — so it reported `diff_lines=202`
instead of the brief's expected `NEW`. This is a filesystem quirk, not a data
error; the file genuinely exists and genuinely differs this much from stock.

`components/ui/Avatar.tsx` takes 9 props — `variant`, `size`, `icon`
(LucideIcon | string), `iconColor`, `backgroundColor`, `borderColor`,
`showBorder`, `useKortixSymbol`, `fallbackText`. RNR's avatar is a 3-part
composition (`Avatar` / `AvatarImage` / `AvatarFallback`) with none of those
props; it renders an image with a text fallback, not an icon avatar with a
Kortix symbol mode.

DECISION (controller ruling R5, 2026-09-05): Avatar.tsx is Kortix-specific, NOT a
duplicate. It MOVES to components/kortix/avatar.tsx with its public API preserved
and its internals rebuilt on RNR Avatar/AvatarImage/AvatarFallback + Icon + tokens.
Its 7 importers change path only. Do NOT delete it, and do NOT rewrite call sites
onto the RNR composition.

The 7 importers, all direct (`from '@/components/ui/Avatar'`), none via the barrel:
  components/ui/ThreadAvatar.tsx, components/triggers/TriggerAvatar.tsx,
  components/projects/AccountMenuSheet.tsx, components/agents/AgentAvatar.tsx,
  components/projects/AccountSwitcherSheet.tsx, app/(tabs)/projects.tsx,
  app/(tabs)/account.tsx
(Also re-exported from the barrel `components/ui/index.ts:1` as `export {
Avatar } from './Avatar'` — that line's import path must be updated to
`../kortix/avatar` in the same move, or removed if nothing consumes `Avatar`
through the barrel — verified: none of the 12 barrel-importing files use
`Avatar` from it.)

## text.tsx — HIGHEST-VALUE FINDING: fork's default font-family would be silently lost
Fork's `textVariants` base class includes `font-roobert` unconditionally:
    cva(cn('font-roobert text-foreground text-base', ...))
Stock's base class has no font-family token at all:
    cva(cn('text-foreground text-base', ...))
`font-roobert` is a real, defined Tailwind utility — `tailwind.config.js`
maps `fontFamily.roobert -> ['Roobert-Regular']` — not dead/unused CSS. It is
the ONLY place in the codebase that sets a default font family with no
font-weight utility present; `global.css` separately remaps
`font-normal/medium/semibold/bold/...` to the matching Roobert file, but that
remap only fires when a `font-*` weight class is explicitly present. Any
`<Text>` instance that specifies no explicit weight class relies on this one
line for its font to be Roobert instead of the OS system font.
`text.tsx` is imported directly by 181 files (verified) — every plain
`<Text>...</Text>` in the app without an explicit `font-*` class is affected.
DECISION: **keep as documented extension.** Re-add `font-roobert` to the base
  class when adopting stock's text.tsx. This is not optional polish — dropping
  it silently reverts default body text to the system font app-wide, directly
  contradicting the standing brand rule (Roobert only, never system/Inter).
  Flag this explicitly to whichever task performs the text.tsx overwrite so it
  is not lost in the noise of the rest of the (mostly cosmetic) diff.

Fork also adds a `label` variant (`text-xs font-medium leading-none`) that
stock does not have.
Real usage: 1 call site —
  components/session/ProjectMoreSheet.tsx:45
    `<Text variant="label" className="px-4 pb-1 pt-3 text-muted-foreground">`
DECISION: drop the `label` variant (1 call site only); re-express at that call
  site as `<Text className="text-xs font-medium leading-none px-4 pb-1 pt-3
  text-muted-foreground">` (no `variant` prop) when text.tsx is overwritten.

(Diff also shows `Slot.Text` (local) vs `Slot` (stock) — this is an
`@rn-primitives/slot` API-surface difference driven by package version
(installed: 1.5.2), not a fork behavior. Flag as a dependency-compat risk for
whichever task runs `add --all`: confirm the installed `@rn-primitives/slot`
version matches what stock text.tsx expects before/after the overwrite.)

## card.tsx — bespoke 4-part Card vs stock's 6-part Card+CardDescription; ZERO real usage
Local Card is a hand-written, unrelated implementation: different signature
(`ViewProps & {className}` vs stock's `React.ComponentProps<typeof View> &
React.RefAttributes<View>`), `border-[1.5px]` / `rounded-lg`, explicit
`font-roobert-semibold` on CardTitle, no `TextClassContext` provider, no
`CardDescription` export at all.
Real usage: **0**. `grep -rl "from '@/components/ui/card'"` (case-insensitive
path check too) returns nothing anywhere in `components/` or `app/`.
DECISION: drop. Take stock's card.tsx wholesale — it is a strict superset
  (adds `CardDescription`, `TextClassContext`) with zero call sites at risk.

## tabs.tsx — custom 3-variant system (`default`/`transparent`/`underline`) via TabsVariantContext; ZERO real usage
Fork adds `TabsVariant`, `TabsVariantContext`, and a `variant` prop on both
`TabsList` and `TabsTrigger` (three distinct visual treatments). Stock ships
one fixed treatment only.
Real usage: **0**. `grep -rl "from '@/components/ui/tabs'"` returns nothing.
DECISION: drop. Take stock's tabs.tsx wholesale.

## select.tsx — 262 diff lines, fork renders a full-screen bottom sheet, stock renders a positioned popover; ZERO real usage
Fork's `SelectContent` is a from-scratch mobile "sheet slides up from the
bottom, 90% max height, `webSheetEase` cubic-bezier slide-in on web" pattern,
with `overlayClassName`/`overlayStyle` escape hatches. Stock's `SelectContent`
is a `@rn-primitives/select` positioned-popover pattern (like a dropdown),
using the newer `NativeOnlyAnimatedView as="Pressable"` overlay-press pattern.
Fork's `SelectTrigger` also threads `buttonVariants`/`buttonTextVariants`
(`variant`, `size`, `content`) through to style the trigger as a Button; stock's
trigger has only `size: 'default' | 'sm'`, no `variant`.
Real usage: **0**. `grep -rl "from '@/components/ui/select'"` returns nothing;
`SelectTrigger` itself is never imported outside `select.tsx`'s own export list.
DECISION: drop. Take stock's select.tsx wholesale. (If a future task wants the
  fork's bottom-sheet select UX back, route it through the same
  `components/kortix/sheet.tsx` gorhom wrapper used for `sheet.tsx`, not by
  reviving this parallel implementation — do not re-introduce a second sheet
  primitive.)

## dropdown-menu.tsx — 249 diff lines, formatting + one real addition; ZERO real usage
Fork's `DropdownMenuGroup` wraps children with `rounded-2xl bg-secondary/50`
styling by default; stock's `DropdownMenuGroup` is a bare passthrough alias
(`= DropdownMenuPrimitive.Group`). Rest of the diff is quote-style/class-order
formatting plus stock's newer `ReduceMotion`/`asChild` overlay-press pattern
(same upstream drift seen in hover-card/popover/tooltip/select).
Real usage: **0**. `grep -rl "from '@/components/ui/dropdown-menu'"` returns nothing.
DECISION: drop. Take stock's dropdown-menu.tsx wholesale.

## context-menu.tsx — 178 diff lines, 100% formatting + upstream drift; ZERO real usage
No fork-added props/variants found (unlike its sibling dropdown-menu.tsx, no
`Group` restyle either). Diff is quote-style/class-order plus the same
`ReduceMotion` upstream addition.
Real usage: **0**. `grep -rl "from '@/components/ui/context-menu'"` returns nothing.
DECISION: drop. Take stock's context-menu.tsx wholesale (zero-risk, no
  behavioral content to preserve).

## input.tsx — adds an unused `variant?: 'default' | 'transparent'` prop; default chrome itself differs at 3 real call sites
Fork type: `InputProps = ComponentProps<TextInput> & { variant?: 'default' |
'transparent' }`. Stock has no `variant` prop at all.
`variant="transparent"` usage: **0** call sites anywhere.
But the *default* (only) styling itself differs from stock's default: fork is
`h-11 rounded-md bg-card p-3 px-4 text-[0.9rem]` (card surface, no border,
14.4px text); stock is `h-10 sm:h-9 rounded-md border border-input
bg-background dark:bg-input/30 px-3 py-1 text-base` (bordered, 16px text).
This is a real visual difference, not an unused variant — it applies to every
one of Input's 3 real call sites:
  app/auth/index.tsx, components/settings/connections/CustomMcpDialog.tsx,
  components/auth/EmailAuthDrawer.tsx
DECISION: drop the `variant="transparent"` prop (0 refs).
DECISION: the default chrome change (bordered input, larger text, no card
  background) is a visual change at 3 call sites — flag for Jay in the M1
  report alongside the button radius change; do not silently take stock's
  default appearance without a visual check of those 3 screens.

## textarea.tsx — default chrome differs from stock; ZERO real usage
Same shape of difference as input.tsx (`rounded-2xl`, `min-h-24`, `p-3 px-4`,
`text-[0.9rem]`, card surface, no border vs stock's `rounded-md border
min-h-16 px-3 py-2 text-base`), but Textarea itself has **0** real call sites
(`grep -rl "from '@/components/ui/textarea'"` returns nothing).
DECISION: drop. Take stock's textarea.tsx wholesale — no call site is affected.

## native-only-animated-view.tsx — stock adds `as="Pressable"` support; must land together with its consumers
Stock adds `AnimatedPressable = Animated.createAnimatedComponent(Pressable)`
and an `as?: "View" | "Pressable"` prop so overlay components can animate a
Pressable (used for the tap-outside-to-dismiss pattern in stock's
dialog/popover/hover-card/tooltip/select/dropdown-menu/context-menu). Local
version only supports View. This is purely additive — nothing is lost by
taking stock — but it is a **dependency**: hover-card.tsx, popover.tsx,
tooltip.tsx, select.tsx, dropdown-menu.tsx, context-menu.tsx, dialog.tsx,
alert-dialog.tsx all reference `as="Pressable"` in their stock versions.
Real usage of native-only-animated-view.tsx itself: 9 files (all within
`components/ui/`, i.e. it is only ever consumed by other ui/ primitives).
DECISION: take stock. No decision needed beyond confirming it lands in the
  SAME overwrite batch as the components that call `as="Pressable"` on it —
  landing it alone, or landing a consumer alone without this file, breaks
  that consumer's overlay-press behavior.

### Post-install deviation from stock (controller ruling R17, 2026-09-05)
After landing stock in the `add --all --overwrite` batch, `tsc --noEmit`
reported a real TS2322 at the file's own line 25 (the `<Animated.View
{...props} />` return): the `props` union's discriminant is optional on the
`as?: "View"` arm and required on the `as: "Pressable"` arm, so TS's
control-flow narrowing on `props.as === "Pressable"` does not fully collapse
the union when the remaining branch spreads `props` onto `<Animated.View>`.
This is an upstream RNR stock typing gap, not a Kortix fork artifact — it
reproduces identically when the same file is typechecked from
`scratchpad/registry/stock/native-only-animated-view.tsx` (excluded from the
app's `tsconfig.json` program as of the R13 fix, but still verified by
running `tsc` against it directly).

WHAT CHANGED: the final `return <Animated.View {...props} />;` became
`return <Animated.View {...(props as React.ComponentProps<typeof
Animated.View>)} />;`, with a 5-line comment above it explaining why. Purely
a type-only cast — **zero runtime behavior change**: the `if (props.as ===
"Pressable")` branch above already returns `<AnimatedPressable>` for that
shape, so by the time execution reaches the cast line, `props` can only be
the `as?: "View"` shape at runtime; the cast just tells TS what the guard
already proved.

WHY: without it, `components/ui/native-only-animated-view.tsx` fails
`tsc --noEmit` with a genuine TS2322, which every consumer that spreads
`as="Pressable"`-style props through this file inherits as a gate-6 failure.
Reverting this cast (i.e. taking stock byte-identical here) costs exactly
**one** `tsc` error — verified: removing the cast reproduces
`components/ui/native-only-animated-view.tsx(25,13): error TS2322: ...` and
moves the project's `tsc --noEmit` error count from 47 to 48.

DECISION: keep the cast. This is the **second** authorized deviation from
stock in `components/ui/` (R8's `font-roobert` in `text.tsx` is the first —
see above). `components/ui/` has exactly two documented deltas from raw
`add --all --overwrite` output: `text.tsx` (R8, `font-roobert` re-added to
the base `textVariants` class) and `native-only-animated-view.tsx` (R17,
type-only cast on the `Animated.View` return). Every other file in
`components/ui/` is byte-identical to its `scratchpad/registry/stock/*`
counterpart, modulo the project's own `@/lib/utils` → `@/lib/utils/index`
alias resolution (not a deviation — shadcn's own alias rewrite, applies
uniformly across all 32 files).

## dialog.tsx — 151 diff lines, formatting + one real upstream fix; ZERO real usage
Stock adds tap-outside-to-close: `DialogOverlay` now computes `onOverlayPress`
and calls `onOpenChange(false)` when the press target equals the overlay
itself. Local version has no such handler — clicking the scrim currently does
not close the dialog. Rest of diff is formatting.
Real usage: **0**. `grep -rl "from '@/components/ui/dialog'"` returns nothing.
DECISION: take stock. Zero call sites at risk, and it is a net behavioral
  improvement (tap-outside-to-dismiss) for whenever Dialog is adopted.

## Formatting-only / upstream-drift-only files — no fork behavior to decide on
The following files' diffs are **100% quote-style / class-order formatting**
(the fork's snapshot predates a Prettier/class-sort pass RNR later applied
upstream) plus, in several cases, upstream fixes the fork's snapshot predates
(`ReduceMotion.System` added to reanimated enter/exit calls so animations
respect the OS "Reduce Motion" accessibility setting; `asChild`/overlay-press
plumbing). No new prop, variant, or Kortix-specific behavior was found in any
of these. DECISION for all: take stock as-is — zero behavior loss.

| file | diff_lines | real importers | notes |
|---|---|---|---|
| accordion.tsx | 79 | 0 | + ReduceMotion on exit animation |
| alert.tsx | 54 | 0 | formatting only |
| alert-dialog.tsx | 64 | 0 | + ReduceMotion, + asChild overlay-press |
| checkbox.tsx | 42 | 0 | formatting only |
| collapsible.tsx | 6 | 0 (re-exported types used internally) | formatting only |
| hover-card.tsx | 41 | 0 | + ReduceMotion, + asChild overlay-press |
| label.tsx | 23 | 1 (CustomMcpDialog.tsx) | formatting only |
| popover.tsx | 45 | 0 | + ReduceMotion, + asChild overlay-press |
| progress.tsx | 30 | 0 | formatting only |
| radio-group.tsx | 23 | 0 | formatting only |
| separator.tsx | 14 | 3 | formatting only |
| switch.tsx | 34 | 0 | formatting only |
| toggle.tsx | 61 | 1 (toggle-group.tsx internal) | formatting only |
| toggle-group.tsx | 66 | 1 (AccountMenuSheet.tsx) | formatting only |
| tooltip.tsx | 58 | 0 | + ReduceMotion, + asChild overlay-press |
| aspect-ratio.tsx | 4 | 0 | quote style only |

`label.tsx` (1 real importer) and `toggle-group.tsx` (1 real importer,
`AccountMenuSheet.tsx`) and `separator.tsx` (3 importers) are safe to
overwrite: their diffs carry zero behavioral change, confirmed above.

## NEW files (no local counterpart at all)
- **menubar.tsx** — no `components/ui/menubar.tsx` under any casing. Nothing
  to reconcile; installs clean.
- **skeleton.tsx** — no `components/ui/skeleton.tsx` under any casing. Nothing
  to reconcile; installs clean.

DECISION for both: install directly, no fork behavior at risk.

## Summary — diff_lines by file (from Step 3, sorted descending)

```
badge.tsx           diff_lines=408
select.tsx           diff_lines=262
dropdown-menu.tsx    diff_lines=249
avatar.tsx           diff_lines=202   (diffed against Avatar.tsx — see Avatar section above)
context-menu.tsx     diff_lines=178
tabs.tsx             diff_lines=108
button.tsx           diff_lines=83
dialog.tsx           diff_lines=81
accordion.tsx        diff_lines=79
text.tsx             diff_lines=78
toggle-group.tsx     diff_lines=66
card.tsx             diff_lines=66
alert-dialog.tsx     diff_lines=64
toggle.tsx           diff_lines=61
tooltip.tsx          diff_lines=58
alert.tsx            diff_lines=54
popover.tsx          diff_lines=45
checkbox.tsx         diff_lines=42
hover-card.tsx       diff_lines=41
switch.tsx           diff_lines=34
input.tsx            diff_lines=34
progress.tsx         diff_lines=30
radio-group.tsx      diff_lines=23
label.tsx            diff_lines=23
textarea.tsx         diff_lines=18
separator.tsx         diff_lines=14
native-only-animated-view.tsx  diff_lines=12
icon.tsx             diff_lines=9
collapsible.tsx      diff_lines=6
aspect-ratio.tsx     diff_lines=4
skeleton.tsx         NEW (not present locally)
menubar.tsx          NEW (not present locally)
```

Note: the brief's Step 3 expected `avatar.tsx` to report `NEW` and expected
`button.tsx` to be among the two largest diffs. Neither held in this real run
— `avatar.tsx` diffed against `Avatar.tsx` due to macOS case-insensitivity
(explained above, and the correct call is still R5's "not a duplicate, keep
and move"), and `select.tsx`/`dropdown-menu.tsx`/`context-menu.tsx` are all
larger than `button.tsx`. All three are addressed above with their own
decisions (all: drop, zero real usage).

## Files with a decision entry: 32 / 32
30 present files (all non-zero diff) + 2 NEW files, all accounted for above.

---

## Jay's decisions on the two flagged visual changes — 2026-09-05

Both flagged at M1 close, both resolved in favour of stock. `components/ui/`
therefore keeps exactly TWO documented deviations (`text.tsx`,
`native-only-animated-view.tsx`) and gains no more.

### button.tsx radius — KEEP STOCK `rounded-md`
The fork defaulted to `rounded-full`. 29 call sites change from pill to rounded
rectangle. Decision: accept the change. `components/ui/button.tsx` stays
byte-identical to registry output, so no re-application is needed after future
`add --all` runs.

### input.tsx chrome — KEEP STOCK bordered / 16px
The fork defaulted to a filled card surface at 14.4px. 3 call sites change.
Decision: accept the change. Stock is also the better mobile default
independently: iOS auto-zooms a focused text input whose font-size is below
16px, so the fork's 14.4px was triggering zoom-on-focus.

No further action in M4/M5 for either — screens inherit the stock defaults.

---

## Task 7 (M2) — color token consolidation: 11 ported, 19 skipped

`global.css` gained 11 tokens (`--surface`, `--pane`, `--hover`, `--active`,
`--focus-ring`, `--foreground-strong`, `--foreground-weak`, `--border-width`,
`--terminal-fg`, `--terminal-surface`, `--terminal-border`) in both `:root`
and `.dark:root`, transcribed from `apps/web/src/app/globals.css` oklch/hex
sources to HSL via the standard OKLab → linear-sRGB → sRGB → HSL pipeline
(verified against the file's own hex comments, e.g. `--surface` dark
`oklch(0.1913 0 0)` → `0 0% 7.8%`, matching the documented `#141414` /
255 = 7.84%). 10 of the 11 (all but `--border-width`) are registered under
`tailwind.config.js` `theme.extend.colors` as `hsl(var(--x))`.

The remaining 19 web tokens are skipped, by group:

**`--kx-titlebar-*` (7): `content-left`, `control-left`, `control-size`,
`control-top`, `controls-width`, `inset`, `lights-end`.** These position an
Electron desktop titlebar's traffic-light controls and content inset. Neither
iOS nor Android renders a titlebar — the OS chrome (status bar, home
indicator, nav bar) is drawn by the platform, not the app. No mobile
equivalent exists to port these onto; a mobile titlebar-geometry token would
have zero consumers.

**`--kx-desktop-zoom` (1).** Electron's page-zoom factor. Mobile has no
analogous zoom concept — screen density is handled by the platform's own
scaling (`PixelRatio` / points vs. pixels), not a CSS zoom variable.

**`--liquid-glass-*` (6): `bg`, `bg-hover`, `blur`, `highlight`, `saturate`,
`shadow`.** These describe a `backdrop-filter: blur() saturate()` frosted
surface. React Native has no `backdrop-filter` CSS property and no NativeWind
utility for one — the RN equivalent is a native blur view (`expo-blur`'s
`BlurView` on iOS, a different composited primitive on Android), configured
with a blur *radius* and *tint*, not a CSS blur px, saturate multiplier, or a
`color-mix()` background string. None of these 6 values are consumable by
that API without a from-scratch reinterpretation, which is a component-layer
decision (out of scope for a tokens-only task) — not a token port.

**`--hit-area-*` (4): `t`, `b`, `l`, `r`.** Defined in web as Tailwind v4
`--spacing(--value(number) * -1)` function-call expressions, not static
values. Tailwind 3.4.14 (mobile's version) has no `--spacing()` function —
these are literally not transcribable as CSS text, only as the evaluated
number they'd produce for one specific `--spacing` base, and mobile
deliberately does not mirror `--spacing` (see below), so there is no base to
evaluate them against even if it wanted to. Mobile's existing equivalent is
the `hitSlop` prop on touchable components, which is already how
`components/ui/*` expands touch targets — no token needed.

**`--spacing` (1). Deliberately NOT ported — this is a trap, not an
oversight.** Web sets `--spacing: 0.23rem`, which multiplies through
Tailwind's entire spacing scale and makes every `p-*`/`m-*`/`gap-*` step 8%
tighter than stock (Tailwind's default `--spacing` is `0.25rem`). Porting it
verbatim would silently shrink `p-2` (8px stock → 7.36px) and `p-3` (12px
stock → 11.04px) below Apple's 44pt minimum touch target on any control sized
in those steps. Mobile keeps stock Tailwind spacing by explicit decision, not
by omission. No `--spacing` key was added to `tailwind.config.js`
`theme.extend`, and `global.css` contains zero `--spacing:` declarations
(verified below).

### Verification

```
$ cd /Users/jay/root/kortix/suna-mobile
$ WEB=$(grep -oE '^[[:space:]]+--[a-z0-9-]+:' apps/web/src/app/globals.css | tr -d ' :' \
    | grep -vE '^--(color|animate|font|text|radius|shadow|ease|duration|spacing|breakpoint|container|leading|tracking|blur|perspective|aspect)-' | sort -u)
$ MOB=$(grep -oE '^[[:space:]]+--[a-z0-9-]+:' apps/mobile/global.css | tr -d ' :' | sort -u)
$ comm -23 <(echo "$WEB") <(echo "$MOB") | tee /tmp/missing.txt | tr '\n' ' '; echo
--hit-area-b --hit-area-l --hit-area-r --hit-area-t --kx-desktop-zoom --kx-titlebar-content-left --kx-titlebar-control-left --kx-titlebar-control-size --kx-titlebar-control-top --kx-titlebar-controls-width --kx-titlebar-inset --kx-titlebar-lights-end --liquid-glass-bg --liquid-glass-bg-hover --liquid-glass-blur --liquid-glass-highlight --liquid-glass-saturate --liquid-glass-shadow --spacing
$ wc -l < /tmp/missing.txt
19
```

All 19 remaining entries are exactly the 5 groups above. See
`.superpowers/sdd/2026-09-05-mobile-rnr-migration/task-7-report.md` for the
full gate output (tsc, `bun test`, per-token presence counts).
