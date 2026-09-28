# Mobile engineering rules

Scope: `apps/mobile/`. Read this with the repository [AGENTS.md](../../AGENTS.md).
Before building or restyling a screen, read the local [design.md](design.md):
it is the canonical source for layout, copy, visual values, and screen-specific
exceptions. Do not copy those decisions into this file. New work follows these
rules even when older screens have not been migrated.

## Primitives

- Import direct paths; there is no `@/components/ui` barrel. Use
  `@/components/ui/text` variants for typography (no `label` variant),
  `button` variants and sizes for actions, `input` / `textarea` / `label` for
  fields, and `switch`, `badge`, `skeleton`, `tabs`, `select`, `popover`,
  `progress`, `separator`, and `context-menu` for their respective controls.
  Use `dialog` for centered overlays and `alert-dialog` for confirmations;
  `@/components/kortix/confirm-dialog` handles plain confirms. Do not build
  per-screen substitutes or restyle primitive typography and dimensions.
- `components/ui/` is RNR registry output with only documented app deltas.
  Keep deviations recorded in `scratchpad/rnr-fork-delta.md`; put Kortix-specific
  composition in `components/kortix/`. If a primitive API changes, inspect and
  update all consumers. Use `pnpm dlx` for the RNR CLI; never run its `init`.
- Prefer `@/components/kortix/avatar` to the low-level UI avatar. Use
  `settings-list` (`SettingsHeader`, `SettingsPage`, `SettingsGroup`,
  `SettingsRow`, `AppearanceRow`) for settings screens; groups own tile surfaces
  and gaps, including the sheet-specific row surface. Use `PlatformButton`
  for header/back actions, `PlatformFullWidthButton` for auth pills, and
  `page-header`, `composer`, and `pinned-bar` where those patterns apply.
- Use `@/components/kortix/pill-input` outside sheets when a pill or focus
  chaining is needed; use `@/components/kortix/SheetInput` inside sheets for
  keyboard-aware input. `Input` / `Textarea` do not forward refs. A raw
  `TextInput` is an exception only when focus chaining requires it; explain why.
  Fields are filled `bg-secondary`, 16pt Roobert, borderless; do not size or
  recolor them locally.
- Button labels come from the size and stay medium weight. No height, width,
  padding, or text sizing classes on buttons or their text children; layout
  classes and `rounded-full` for pills are fine. `xl` is for auth welcome pills;
  `icon-md` is for composer controls and `icon-sm` for turn actions. Other icon
  buttons use `icon`. Give icon-only buttons an `accessibilityLabel`.

## Icons, sheets, and feedback

- Import Phosphor icons only from `@/lib/icons`; add missing icons through
  `lib/icons/index.ts`, not the package barrel or another icon library. Use
  `AppIcon` for icon-valued props. The app weight is bold; only solid glyphs
  override it with `weight="fill"`. Set color through `<Icon className="text-*">`
  or `color`, not `style.color` on a bare icon. Brand marks live in
  `components/icons/`. `lib/icons/icon-imports.test.ts` guards imports.
- Render bottom sheets through `KortixBottomSheetModal` in
  `components/kortix/sheet.tsx` (or its `<Sheet>` wrapper for a simple new
  sheet), never raw `BottomSheetModal`. Its chrome, title row, safe-area inset,
  and full-screen detent are defaults: do not duplicate them or add `100%` at
  call sites. Gorhom content/scroll/input parts remain valid inside it. Use
  `SheetFill` for pinned content in a fixed-detent sheet, and `PinnedBar` for
  controls over the scrolling surface. Override backdrop or chrome only for a
  documented design exception. Dismiss one overlay before opening another.
- Use `useToast()` from `components/kortix/toast-provider.tsx` for results,
  never import `sonner-native` in a screen. Use `AlertDialog` for destructive
  confirmations, not `Alert.alert`; a one-button acknowledgement obscured by a
  native modal is the narrow exception. Use `openLink` in
  `lib/utils/open-link.ts` for ordinary web links, not OAuth/checkout return
  flows or `tel:` / `mailto:` links.

## Tokens, touch, and loading

- `global.css` owns colors; `lib/utils/theme.ts` derives `THEME` / `NAV_THEME`.
  Avoid hex, `rgb()` / `rgba()`, and stock Tailwind palette colors. A fixed
  literal needs a `hex-allowlist:` comment naming its expected value. Do not
  parse token colors as hex or concatenate alpha suffixes; use `withAlpha`.
  `primaryForeground` is for text on `primary`: dark mode's value is dark.
  Check the rendered light/dark values before mapping a token.
- Mobile uses stock Tailwind spacing, not web's tighter `--spacing`. Use 16pt
  side edges (`px-4`) and one less vertical step on padded rows (`px-3 py-2`,
  `px-4 py-3`, `px-5 py-4`). Keep controls at a 44pt touch target: `Button`
  adds default hit slop; preserve it when overriding a box, including the
  36pt composer and 28pt turn-action buttons. Respect safe areas and reduced
  motion. See `design.md` for screen-specific placement and exceptions.
- Use `@/components/ui/skeleton` or `@/components/kortix/kortix-loader` for
  loading, not `ActivityIndicator` or a spun icon. Show one loader per visible
  surface. The native splash owns boot until it hides; covered surfaces do not
  show another loader. An in-progress action inside a loading surface uses a
  disabled state instead of a second spinner.

Existing raw `Modal` and dense raw `Text` sites are not a migration mandate.
Do not extend them in new UI; convert an existing site only when you own its
whole flow. Verify visual changes in both themes and on a device-sized screen.
