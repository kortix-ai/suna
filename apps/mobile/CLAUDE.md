# Kortix Mobile — UI conventions (READ FIRST, ENFORCE ALWAYS)

> **Also read `design.md` in this folder before building or restyling a
> screen.** This file says which primitive to use; `design.md` says how a
> screen looks — the settings-screen layout (`SettingsPage` / `SettingsGroup`
> / `SettingsRow`), button placement, auth screens, and exact values.

This app has a small, canonical set of UI primitives. Always use them. Never
re-implement, wrap, or hand-roll their behavior, and never repeat their
styling inline. If a primitive is missing a capability, extend the primitive
— do not work around it in a screen.

`components/ui/` is unmodified React Native Reusables (RNR) registry output —
32 files, no barrel, no capitalized filenames. `components/kortix/` is
Kortix-specific: 23 files, built on top of `components/ui/`. **There is no
`@/components/ui` barrel.** Import direct paths only, e.g.
`@/components/ui/button`, `@/components/kortix/avatar`.

## Canonical UI primitives — `components/ui/` (RNR registry, 32 files)

| Need | Use ONLY | Never |
| --- | --- | --- |
| Any text | `@/components/ui/text` → `<Text variant="…">` | raw `<Text>` from `react-native`, or repeating `font-roobert text-[..px] text-…` |
| Any button / pressable action | `@/components/ui/button` → `<Button variant="…" size="…">` | raw `<Pressable>`/`<TouchableOpacity>` styled as a button |
| Single-line text field | `@/components/ui/input` → `<Input>` | raw `<TextInput>` |
| Multi-line text field | `@/components/ui/textarea` → `<Textarea>` | raw `<TextInput multiline>` |
| Field label | `@/components/ui/label` → `<Label>` | ad-hoc label `<Text>` with custom size/weight |
| Icons | `@/components/ui/icon` → `<Icon as={XIcon} />`, or `<XIcon />`, with icons from `@/lib/icons` — see **Icons** below | importing `phosphor-react-native`, `lucide-react-native`, or `@expo/vector-icons`; ad-hoc svg in screens |
| Dialog (centered overlay) | `@/components/ui/dialog` → `<Dialog>` + parts | custom centered overlay, raw `Modal` |
| Alert dialog (confirm/cancel) | `@/components/ui/alert-dialog` → `<AlertDialog>` + parts | `Alert.alert`, custom confirm overlays |
| Inline alert | `@/components/ui/alert` → `<Alert>` + `AlertTitle` / `AlertDescription` | custom banner boxes |
| Badge | `@/components/ui/badge` → `<Badge variant="…">` | ad-hoc pill `View` |
| Skeleton loading state | `@/components/ui/skeleton` → `<Skeleton>` | ad-hoc `animate-pulse` boxes — see also **Loading** rule below |
| Card surface | `@/components/ui/card` → `<Card>` + `CardHeader` / `CardTitle` / `CardContent` / `CardFooter` | ad-hoc bordered/rounded `View` cards |
| Accordion | `@/components/ui/accordion` → `<Accordion>` + parts | custom expand/collapse |
| Collapsible | `@/components/ui/collapsible` → `<Collapsible>` + parts | custom show/hide |
| Checkbox | `@/components/ui/checkbox` → `<Checkbox>` | custom check `Pressable` |
| Switch | `@/components/ui/switch` → `<Switch>` | raw RN `Switch` styled ad-hoc |
| Radio group | `@/components/ui/radio-group` → `<RadioGroup>` + `RadioGroupItem` | custom radio rows |
| Toggle | `@/components/ui/toggle` → `<Toggle>` | custom pressed chip |
| Toggle group | `@/components/ui/toggle-group` → `<ToggleGroup>` + `ToggleGroupItem` | custom segmented control |
| Tabs | `@/components/ui/tabs` → `<Tabs>` + `TabsList` / `TabsTrigger` / `TabsContent` | custom tab bars |
| Menu bar | `@/components/ui/menubar` → `<Menubar>` + parts | custom top-level app menu |
| Select | `@/components/ui/select` → `<Select>` + parts | custom picker menus |
| Dropdown menu | `@/components/ui/dropdown-menu` → `<DropdownMenu>` + parts | custom action menus |
| Context menu | `@/components/ui/context-menu` → `<ContextMenu>` + parts | custom long-press menus |
| Popover | `@/components/ui/popover` → `<Popover>` + parts | custom anchored overlays |
| Hover card | `@/components/ui/hover-card` → `<HoverCard>` + parts | custom hover/preview overlays |
| Tooltip | `@/components/ui/tooltip` → `<Tooltip>` + parts | custom tooltip overlays |
| Progress | `@/components/ui/progress` → `<Progress>` | custom progress bars |
| Separator | `@/components/ui/separator` → `<Separator>` | ad-hoc `border-b` / hairline `View`s |
| Aspect ratio | `@/components/ui/aspect-ratio` → `<AspectRatio>` | manual width/height ratio math |
| Avatar (3-part composition) | `@/components/ui/avatar` → `<Avatar>` + `AvatarImage` / `AvatarFallback` | see **Avatar** section — most screens want `@/components/kortix/avatar` instead |
| Native-only animated wrapper | `@/components/ui/native-only-animated-view` → `<NativeOnlyAnimatedView>` | animating a view that must also render inertly on web |

## Kortix-specific components — `components/kortix/` (23 files)

| File | Purpose |
| --- | --- |
| `avatar.tsx` | The single-prop avatar most screens use (agent/model/thread/trigger/custom). See **Avatar** section. |
| `ThreadAvatar.tsx` | Thin wrapper around `kortix/avatar` for thread rows. |
| `sheet.tsx` | `<Sheet>` bottom-sheet wrapper + `SheetHeader`/`SheetBody`/`SheetFooter`, and the shared gorhom chrome — `SheetBackdrop`, `sheetHandleIndicatorStyle(isDark)`, `useSheetBackground()`. See **Bottom sheets** invariant below. |
| `SheetInput.tsx` | Canonical pill text field for inside a bottom sheet (wraps gorhom's `BottomSheetTextInput`). |
| `pill-input.tsx` | `PillInput` — the same pill on a plain `TextInput`, for full screens outside a sheet (the auth forms). Forwards its ref. Exports `usePillInputStyle`, the one source of the pill's look for both fields. |
| `settings-list.tsx` | `SettingsHeader` / `SettingsPage` / `SettingsGroup` / `SettingsRow` / `AppearanceToggle` — the only layout for settings-style screens ((settings) stack, Account tab, Accounts, Billing): back-button header (optional centred + transparent variant), page with an optional full-bleed `hero` above a rounded sheet, sentence-case group title, borderless `rounded-2xl` card, full-width separators, icon · label · trailing rows, `AppearanceRow` (opens a System/Light/Dark dialog with a check on the active mode). See `design.md` → Settings screens. |
| `search-header.tsx` | `SearchHeader` — iOS-style search mode for a screen header: filled 40pt pill (magnifier, auto-focused field, round clear button) + Cancel. A screen swaps its header row for it (projects header search). |
| `platform-button.tsx` | `PlatformButton` — native SwiftUI button (`@expo/ui`, plain style on the `secondary` fill; no Liquid Glass, its shadow clips) on iOS, design-system `Button` with `rounded-full` on Android. Used for the projects "New" button and the settings Go back button. Same file: `PlatformFullWidthButton` — a full-width pill (label centred, `leading` React Native element pinned to the left edge) drawn natively on iOS in the design-system variant's tokens (`default` / `outline`, `size` `lg` / `xl`), design-system `Button` elsewhere; used by the auth welcome screen's three sign-in pills. Both fall back to the design-system button when the running binary lacks the `ExpoUI` native module (OTA-safe). |
| `KortixLogo.tsx` | Brand mark / wordmark, light and dark SVG variants. |
| `SearchBar.tsx` | Standalone search input with clear button. |
| `search-list-header.tsx` | "Search input + add button" row under `PageHeader` on list pages. |
| `page-header.tsx` | Unified top header (hamburger / title / "···" more button) for every page. |
| `page-content.tsx` | Content area under `PageHeader` — no card framing, consistent top spacing. |
| `list-row.tsx` | Standard settings-style row (`title` / `subtitle` / `left` / `right` / divider). |
| `composer.tsx` | The chat input of the project home and of a thread (`SessionChatInput` wraps it): one card with the text field on top and a 36pt row of add · model · send `Button`s below (`icon-md` icon buttons, `sm` model pill). Page colour (`bg-background`) in both themes, hairline `border-border` in both themes, no shadow. No animated placeholder. Thread-only slots: `header` (queue, staged command), `accessory` (AutoContinue), `busy` (Stop). See design.md → Project home. |
| `pinned-bar.tsx` | `PinnedBar` + `usePinnedBarInset`. Inside a bottom sheet, wrap the body in `SheetFill` (`sheet.tsx`) first: gorhom's content box is taller than the visible sheet, so `bottom: 0` alone lands off-screen.  — controls pinned to the bottom of a scrolling region, floating over a fade of the surface (clear → 85% at 45% → solid), 16pt above the safe area; the content scrolls under it and pads its end by the inset. The project drawer's bottom bar as a component (Jay, 2026-09-22); used by the session file preview sheet (Download · Add to chat). Never a solid footer under a separate fade strip. |
| `animated-toggle-icon.tsx` | Cross-fade + rotate between an icon and its "X" close state, used by `PageHeader`. |
| `kortix-loader.tsx` | Lottie brand loading spinner. |
| `ShimmerText.tsx` | Gradient-sweep shimmer text for "AI is working" status lines. |
| `StopIcon.tsx` | Stop-square SVG icon used on the composer's stop button. |
| `OfflineBanner.tsx` | Global connectivity banner (slides in on disconnect / brief "Back online" flash). |
| `selectable-markdown.tsx` | Selectable markdown text via `@expensify/react-native-live-markdown`. |
| `toast.tsx` / `toast-provider.tsx` | Toast primitive + provider/context. `useToast()` returns the toast functions: `const toast = useToast(); toast.error(...)`. |

Plurality rule: if you find yourself writing the same `className` string on more
than one `<Text>`, you are doing it wrong — that styling already exists as a
`Text` variant. Add a variant to `text.tsx` before inlining.

## Text — use the variants, not custom CSS

`components/ui/text.tsx` sets `font-roobert text-foreground text-base` on the
base. Pick a `variant`; do not restate size/weight/color with classes. Stock
ships exactly these 12 — there is **no** `label` variant:

| variant | Purpose | Style |
| --- | --- | --- |
| `default` | Plain body | `text-base` |
| `h1` | Page hero heading | `text-4xl font-extrabold tracking-tight` |
| `h2` | Section heading (with bottom border) | `text-3xl font-semibold tracking-tight` |
| `h3` | Sub-section heading | `text-2xl font-semibold tracking-tight` |
| `h4` | Card / group heading | `text-xl font-semibold tracking-tight` |
| `p` | Body paragraph | `leading-7`, `mt-3` |
| `blockquote` | Quoted block | italic, left border |
| `code` | Inline code | mono, `text-sm` |
| `lead` | Intro line | `text-muted-foreground text-xl` |
| `large` | Emphasis / sheet title | `text-lg font-semibold` |
| `small` | Dense label / inline action | `text-sm font-medium leading-none` |
| `muted` | Secondary / helper text | `text-muted-foreground text-sm` |

- ✅ `<Text variant="muted">Forgot your password?</Text>`
- ❌ `<Text className="font-roobert text-[13px] text-muted-foreground">…`
- Inside a `<Button>`, just render `<Text>…</Text>` — the button styles it via `TextClassContext`.
- Only add a `className` to `Text` for **layout** (`mt-3`, `text-center`) or a genuinely one-off color on a fixed-palette surface (e.g. always-dark hero). Never for size/weight that a variant already encodes.
- Need an eyebrow / field-label style? There is no `label` variant. Use
  `@/components/ui/label` for form labels, or an explicit one-off className
  for eyebrow text — do not resurrect `variant="label"`.

## Button

`components/ui/button.tsx` is `rounded-md` (not `rounded-full`). Children are
styled through `TextClassContext`, so pass a plain `<Text>` (and `<Icon>`) as
children.

- Variants: `default` `secondary` `destructive` `outline` `ghost` `link`.
  Gone: `secondary-outline` `accent` `card` `transparent` `inverted` `white`
  `black` — do not reintroduce them.
- Sizes: `default` (`h-10`) `sm` (`h-9`) `lg` (`h-11`) `xl` (`h-12`) `icon` (`h-10 w-10`) `icon-md` (`h-9 w-9`) `icon-sm` (`h-7 w-7`).
  `icon-md` is added to the registry output (Jay, 2026-09-21): the 36pt round controls of
  the composer's row (add, send, Stop, AutoContinue), beside a `sm` model pill. Always pair
  it with `hitSlop={COMPOSER_CONTROL_HIT_SLOP}` (4pt) so the touch target stays 44pt.
  `icon-sm` is added to the registry output (Jay, 2026-09-21): the 28pt action under a chat
  message (Copy, Edit, turn details). Always pair it with `hitSlop` so the touch target
  stays 44pt tall (`TURN_ACTION_HIT_SLOP`). Every icon button outside the composer row and
  the message actions stays `icon` (40pt).
  `xl` is added to the registry output. Only the auth welcome screen's
  three sign-in pills use it (Jay, 2026-09-17). Every other pill stays `lg`.

**No sizing classes on a Button.** Never pass a height, width, padding, or
text size/weight in a `Button`'s `className` (`h-14`, `h-[46px]`, `px-1`,
`text-base`), or on its `<Text>` child. Pick `size` and `variant`. Allowed:
layout-only classes (`mt-*`, `flex-1`, `self-*`) and `rounded-full` for a pill
(e.g. the auth screen's provider buttons).

**Label size follows `size`.** `buttonTextVariants` in
`components/ui/button.tsx` maps `size="lg"` and `size="xl"` to `text-base font-medium`
(16px Roobert Medium). `default`, `sm`, and `icon` keep stock `text-sm
font-medium`. Button labels are always medium, never semibold (Jay, 2026-09-16). A `<Text variant="large">` inside a Button does nothing: `Text`
merges `cn(textVariants, TextClassContext, className)`, so the button context
overrides the variant's size and weight. If a screen needs a different label,
change `buttonTextVariants` (and check every consumer), don't patch around it.

## Input / Textarea

- `<Input>` — stock `TextInputProps`, **no `variant` prop**. Filled
  `bg-secondary`, **no border**, `font-roobert text-base` (16px Roobert
  Regular), `rounded-xl`, `h-11`, muted placeholder. No input in the app has
  a border (Jay, 2026-09-14) — never add one back by class. It is a plain function component,
  **not `forwardRef`** — `ref.focus()` does not work. A screen that needs
  focus-chaining keeps a raw `TextInput` for that field and says why in a
  comment; do not silently drop the chaining.
- `<Textarea>` — multiline field, same non-`forwardRef` caveat applies.
- For a pill field on a full screen (44pt, matches `Button size="lg"`), use
  `@/components/kortix/pill-input` → `<PillInput>`. It forwards its ref, so
  it supports focus-chaining. `BottomSheetTextInput` throws outside a sheet,
  so never reuse `SheetTextInput` there.
- Inside a bottom sheet, use `@/components/kortix/SheetInput` instead — it
  wraps gorhom's `BottomSheetTextInput` so the keyboard behaves correctly.

## Avatar — two different things, don't confuse them

- `@/components/ui/avatar` — RNR's 3-part composition: `Avatar` /
  `AvatarImage` / `AvatarFallback`. Low-level; rarely used directly.
- `@/components/kortix/avatar` — the single-prop Kortix component
  (`variant="agent" | "model" | "thread" | "trigger" | "custom"`, `icon`,
  `size`, …) that most screens actually want. Built on top of
  `@/components/ui/avatar`'s `Avatar`/`AvatarFallback` (it never uses
  `AvatarImage` — it renders an icon, the Kortix symbol, or a fallback letter,
  never a remote image).

## Bottom sheets

RNR ships no bottom-sheet primitive. The app's sheets are `@gorhom/bottom-sheet`
modals (74 sites in 50 files): converting them to `<Dialog>` would lose
pan-down-to-dismiss, snap points, and keyboard-aware sizing, so they stay on
gorhom. Its content parts (`BottomSheetView`, `BottomSheetScrollView`,
`BottomSheetTextInput`, `BottomSheetFooter`) are still imported from gorhom.

**Every sheet renders through `KortixBottomSheetModal`** (`components/kortix/sheet.tsx`;
Jay, 2026-09-22). It is a drop-in for gorhom's `BottomSheetModal`: the same props
and the same ref, so `useRef<BottomSheetModal>` (the gorhom type) still types the
ref. It owns the sheet's look: the backdrop (`SheetBackdrop`), the grab handle,
the surface colour, the 20pt top corners, and the title row (`SHEET_DEFAULTS`).
Change a value there and every sheet changes. **Never render a raw
`<BottomSheetModal>`**, and never pass `backdropComponent`, `handleIndicatorStyle`
or `backgroundStyle` to restate a default. Pass one only to differ on purpose
(the 11 sites with a lighter backdrop), and say why.

**Every sheet reaches full screen** (Jay, 2026-09-22). `KortixBottomSheetModal`
appends `'100%'` to the `snapPoints` a call site passes (`withFullDetent`,
`lib/ui/sheet-detents.ts`), and turns no `snapPoints` (a content-sized sheet)
into `['100%']` beside gorhom's dynamic detent. The sheet opens at the size the
call site asked for and a drag up expands it. `topInset` defaults to the
safe-area top, so 100% stops under the status bar; pass `topInset` only to
differ. Never add `'100%'` at a call site. gorhom sizes the content box to the
highest detent, so a fixed-detent sheet (`enableDynamicSizing={false}`) is
wrapped in `SheetFill` by the component: its body is exactly the visible
sheet, `flex: 1` and `absolute bottom-0` inside it mean the visible edge, and
the body grows with the drag.

`title="…"` adds the title row in the handle area, above any content: a close
button at the far left, the title centred (`Text variant="large"`), a spacer
that balances the button. `hideClose` drops the button. `titleTrailing` puts one
40pt icon `Button` (`variant="ghost" size="icon" rounded-full`) at the far right in
place of that spacer — the file preview's Copy (`SessionFilesSheet`); the slot
mirrors the close button's, so the title stays centred. One control only: a second
action belongs in the sheet's content. Do not hand-roll a title
row inside a sheet's content.

`components/kortix/sheet.tsx` also gives:
1. `<Sheet>` + `SheetHeader`/`SheetBody`/`SheetFooter` — a ready-made wrapper
   (built on `KortixBottomSheetModal`) for a new sheet that doesn't scroll.
   Prefer this for new sheets.
2. The chrome `KortixBottomSheetModal` applies: `SheetBackdrop`,
   `sheetHandleIndicatorStyle(isDark)`, and `useSheetBackground()`. A call site
   needs one only to differ on purpose — a lighter overlay is
   `backdropComponent={(p) => <SheetBackdrop {...p} opacity={0.4} />}` — or to
   paint something in the sheet's colour (a pinned footer). Never hand-roll a
   backdrop opacity, a handle colour, or a background colour: that duplication
   is the drift `KortixBottomSheetModal` ended.

Adoption is complete and mechanically checked. All five greps return 0:

```bash
grep -rnE "^\s*<BottomSheetModal(\s|$)" components/ app/ --include='*.tsx' | grep -v components/kortix/sheet.tsx
grep -rn "BottomSheetBackdrop"      components/ app/ --include='*.tsx' | grep -v components/kortix/sheet.tsx
grep -rn "handleIndicatorStyle={{"  components/ app/ --include='*.tsx'
grep -rn "backgroundStyle={{"       components/ app/ --include='*.tsx' | grep -i "#\|rgba"
grep -rnE "#[0-9a-fA-F]{6}|rgba\(" components/ app/ --include='*.tsx' | grep -v hex-allowlist
```

One legacy duplicate survives: `getSheetBg` in `lib/theme-colors.ts` returns the
same value as `useSheetBackground()`. It is token-derived, not a literal, so it
is not a color bug — but it is a second name for one concept. Use
`useSheetBackground()`; do not add `getSheetBg` call sites.

## Loading

Loading state is always `@/components/ui/skeleton`'s `<Skeleton>` (a
`bg-accent animate-pulse` box) or the Kortix Lottie spinner
(`@/components/kortix/kortix-loader`). Never an icon spun with `animate-spin`.

## Icons

One library: Phosphor (`phosphor-react-native`), the same glyphs and weight as
`apps/web`.

- Import every icon from `@/lib/icons`. Add a missing one to
  `lib/icons/index.ts`: one import line (`phosphor-react-native/src/icons/<Name>`)
  and one `withAppWeight` export line. Never import the package elsewhere:
  Metro tree shaking is off, so the package barrel ships 1,512 icons in 6
  weights.
- Never pass `weight`. `DEFAULT_ICON_WEIGHT` in `lib/icons/icon-config.ts`
  (`bold`) sets it for the whole app. The only override is `weight="fill"` for a
  solid glyph (a filled star, a checked box). There is no `strokeWidth`.
- Pass an icon as a value with the `AppIcon` type (`icon: AppIcon`), never a
  string name.
- Color: `<Icon className="text-*">` or an explicit `color` prop. Phosphor
  ignores `style.color`; `components/ui/icon.tsx` reads it for you. A bare
  `<XIcon />` without `color` renders black.
- Brand marks (Google, Apple, Gmail, Slack, provider logos) are SVG components
  in `components/icons/`, not registry icons.
- `lib/icons/icon-imports.test.ts` enforces this: retired libraries, direct
  package imports, unused registry entries, non-`fill` weights, spinner glyphs.

## Do / Don't

- ✅ One source of truth per primitive; extend the primitive when it lacks something.
- ✅ `Text` variants for every size/weight/secondary-color decision.
- ✅ Prefer the tables above for overlays, menus, form controls, and layout chrome.
- ❌ Re-declaring `font-roobert`, `text-[NNpx]`, `text-muted-foreground`, `text-sm`, etc. on `Text`.
- ❌ New per-screen input/button/dialog/menu wrappers that duplicate these.
- ❌ Raw `react-native` `Text`/`TextInput`/`Pressable`/`Switch` for styled UI.

## When you change a primitive's API

If you change any file under `components/ui/` (especially `input.tsx` /
`button.tsx` / `text.tsx`) or `components/kortix/sheet.tsx`, update **every
consumer** in the same change (grep the imports) — a simplified primitive
that drops props silently breaks the screens that still pass them.

## Color

1. **`global.css` is the single source of color.** Every token is a
   transcription of an `apps/web/src/app/globals.css` token, with the oklch
   original in a trailing comment. `THEME` / `NAV_THEME` in
   `lib/utils/theme.ts` derive from these values and are pinned by
   `lib/utils/theme.test.ts`.
2. **Mobile intentionally uses stock Tailwind spacing, not web's scale.**
   Web sets `--spacing: 0.23rem` (8% tighter than stock). Mobile does not
   mirror it — the tighter scale pushes `p-2`/`p-3` touch targets below the
   44pt HIG minimum.
3. **Three forms of hardcoded color are banned, not just one:** hex
   (`#3F3F46`), `rgba()`/`rgb()`, and stock Tailwind palette classes
   (`text-emerald-500`, `bg-zinc-900`, any
   `{bg,text,border,ring}-{slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose}-{50|100..900}`).
   A grep for hex alone misses two-thirds of them. A literal is allowed only
   behind a `// hex-allowlist:` comment that names the **expected value**
   ("near-white hsl(60 0% 98%)"), not just the intent ("fixed white text") —
   intent alone did not stop the bug in rule 5 below.
4. **Never build a color by string concatenation.** `` `${cfg.color}22` `` or
   `accent + '30'` only worked while the source was hex. `THEME` values are
   `hsl(...)` strings, so concatenation produces a non-color React Native
   silently ignores. Use `withAlpha(color, alpha)` from `@/lib/utils/theme`.
5. **Never parse a color as hex**, e.g. `parseInt(base.slice(1,3), 16)` — same
   assumption in reverse, breaks the same way against an `hsl(...)` source.
6. **`primaryForeground` is inverted from its name.**
   `THEME.light.primaryForeground` is near-white (`hsl(60 0% 98%)`);
   `THEME.dark.primaryForeground` is near-black (`hsl(180 0% 9%)`). It is the
   foreground that sits *on* that theme's `primary` fill — and dark mode's
   `primary` is a near-white fill. For fixed light-on-color text (white text
   on a destructive-red button, regardless of theme), use
   `THEME.light.primaryForeground`. Five sites shipped ~2.5:1 contrast by
   reading the name instead of the value.
7. **Map color by rendered appearance, not by name or ternary branch.** Three
   `isDark ? a : b` pairs in this codebase had their branches swapped — the
   "dark" branch held the lighter value. Check both literals' actual
   lightness before converting a ternary to a token.
8. `THEME.accent.{blue,yellow,orange,green,purple,red}` is theme-invariant
   brand color — same value in both themes. `THEME.light.*` / `THEME.dark.*`
   is semantic and flips per theme. Don't confuse the two `accent` things:
   `THEME.accent.*` (brand) vs. `THEME.light.accent` / `THEME.dark.accent`
   (the semantic `--accent` token, which does invert).

## Known unmigrated state (not a TODO — don't convert without owning it)

- **Raw `Modal` from `react-native`** still ships in several screens
  (session, billing, files, menu, threads, updates). Converting one to
  `<Dialog>` is a structural change with no gate behind it. New code uses
  `<Dialog>` / `<AlertDialog>`; existing `Modal` sites stay until someone
  owns that conversion end to end.
- **Raw `Text` from `react-native`** still ships in a handful of files with
  dense custom typography — notably `components/pages/ApiKeysPage.tsx` and
  `components/session/SessionChatInput.tsx`. New code uses
  `<Text variant="…">`.

## Invariants (mechanically checked)

1. `components/ui/` contains ONLY RNR registry output — 32 files, no barrel,
   no capitalized filenames. A file here that differs from
   `https://reactnativereusables.com/r/nativewind/<name>.json` is a bug.
   Never edit one; extend it in `components/kortix/` and record the reason in
   `scratchpad/rnr-fork-delta.md`.

   Check it against the captured upstream sources. **Normalize the import path
   first** — the RNR installer rewrites `'@/lib/utils'` to `'@/lib/utils/index'`
   in every file it emits, so a naive `diff` reports all 30 `cn`-importing files
   as forked and tells you nothing:

   ```bash
   for f in scratchpad/registry/stock/*.tsx; do
     b=$(basename "$f")
     diff <(sed "s#'@/lib/utils'#'@/lib/utils/index'#" "$f") "components/ui/$b"
   done
   ```

   `scratchpad/registry/` is **gitignored**, so a fresh clone has no captured
   sources to diff against. Recreate them by installing the registry into a
   throwaway directory and copying the output:
   `pnpm dlx @react-native-reusables/cli@latest add --all` in a scratch Expo app.
   The permanent record of what deviates is `scratchpad/rnr-fork-delta.md`,
   which IS tracked — that file, not the captures, is the source of truth.

   Stock RNR imports its icons from `lucide-react-native`. This app imports the
   same glyphs from `@/lib/icons` (Phosphor). In 8 files (`accordion`, `alert`,
   `checkbox`, `context-menu`, `dialog`, `dropdown-menu`, `menubar`, `select`)
   that import line is the icon delta, and `icon.tsx` is rewritten for Phosphor.
   These are recorded in `rnr-fork-delta.md` → Icon library, and are not forks.

   Beyond the icon delta, exactly six files may differ, all recorded in `rnr-fork-delta.md`:
   `text.tsx` (adds `font-roobert` to the base class — 164 importers depend on
   it, and React Native cannot synthesize the family),
   `native-only-animated-view.tsx` (a cast around an upstream typing gap that
   reproduces against stock), and `button.tsx` (`size="lg"` label is
   `text-base font-medium`, plus an added `xl` size — `h-12`, same label —
   and added `icon-md` (`h-9 w-9`) and `icon-sm` (`h-7 w-7`) sizes —
   so no screen sets label or box size by class; no added `variant`s),
   and `input.tsx` (borderless filled field in Roobert — no input has a
   border), and `dialog.tsx` + `alert-dialog.tsx` (no `border` on the
   content; `DialogContent` renders its X close button only with
   `showCloseButton` — Jay, 2026-09-15; content surface is `bg-popover`, the
   bottom-sheet token, over a `bg-black/70` overlay — Jay, 2026-09-16). A
   seventh entry means someone forked a primitive.
2. `global.css` is the single source of color (see **Color** above),
   pinned by `lib/utils/theme.test.ts`.
3. Mobile spacing intentionally diverges from web's tighter scale (see
   **Color** rule 2 above). Do not mirror web's `--spacing`.
4. `components/kortix/sheet.tsx` is the only file that may define
   `SheetBackdrop` / `sheetHandleIndicatorStyle` / `useSheetBackground` — new
   gorhom call sites import these, they don't redefine them.

## Tooling

- Use `pnpm dlx @react-native-reusables/cli@latest`, not `npx`: this is a
  pnpm workspace, and `npx` resolves against npm semantics instead.
- **Never run `init`** — it scaffolds a new Expo project and destroys this app.
- `doctor` reports three findings on this repo (2 Missing Files: Theme,
  Utils; 1 Misconfigured: Babel Config). All three are **false positives**:
  no registry component imports `THEME`, `@/lib/utils` resolves via
  `lib/utils/index.ts`, and `babel.config.js:4` already has
  `nativewind/babel`. Do not "fix" them.
