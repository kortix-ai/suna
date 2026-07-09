# Kortix Mobile — UI conventions (READ FIRST, ENFORCE ALWAYS)

This app has a small, canonical set of UI primitives. **Always use them. Never
re-implement, wrap, or hand-roll their behavior, and never repeat their styling
inline.** If a primitive is missing a capability, extend the primitive — do not
work around it in a screen.

## Canonical UI primitives — use these, never re-implement

| Need | Use ONLY | Never |
| --- | --- | --- |
| Any text | `@/components/ui/text` → `<Text variant="…">` | raw `<Text>` from `react-native`, or repeating `font-roobert text-[..px] text-…` |
| Any button / pressable action | `@/components/ui/button` → `<Button variant="…" size="…">` | raw `<Pressable>`/`<TouchableOpacity>` styled as a button |
| Single-line text field | `@/components/ui/input` → `<Input variant="…">` | raw `<TextInput>` |
| Multi-line text field | `@/components/ui/textarea` → `<Textarea>` | raw `<TextInput multiline>` |
| Field label | `@/components/ui/label` → `<Label>` | ad-hoc label `<Text>` with custom size/weight |
| Icons | `@/components/ui/icon` → `<Icon as={LucideIcon} />` | ad-hoc svg/vector-icon usage in screens |
| Bottom sheets | `@/components/ui/sheet` → `<Sheet fullScreen? >` + `SheetBody` | a new gorhom modal per screen |
| Modal / overlay | `@/components/ui/modal` → `<Modal>` | hand-rolled `RNModal` + backdrop |
| Dialog | `@/components/ui/dialog` → `<Dialog>` + parts | custom centered overlay |
| Alert dialog | `@/components/ui/alert-dialog` → `<AlertDialog>` + parts | custom confirm/cancel overlay |
| Alert modal (app-level) | `@/components/ui/alert-modal` | `Alert.alert` / one-off confirm sheets |
| Inline alert | `@/components/ui/alert` → `<Alert>` + `AlertTitle` / `AlertDescription` | custom banner boxes |
| Card surface | `@/components/ui/card` → `<Card>` + `CardHeader` / `CardTitle` / `CardContent` / `CardFooter` | ad-hoc bordered/rounded `View` cards |
| Accordion | `@/components/ui/accordion` → `<Accordion>` + parts | custom expand/collapse |
| Collapsible | `@/components/ui/collapsible` → `<Collapsible>` + parts | custom show/hide |
| Checkbox | `@/components/ui/checkbox` → `<Checkbox>` | custom check `Pressable` |
| Switch | `@/components/ui/switch` → `<Switch>` | raw RN `Switch` styled ad-hoc |
| Radio group | `@/components/ui/radio-group` → `<RadioGroup>` + `RadioGroupItem` | custom radio rows |
| Toggle | `@/components/ui/toggle` → `<Toggle>` | custom pressed chip |
| Toggle group | `@/components/ui/toggle-group` → `<ToggleGroup>` + `ToggleGroupItem` | custom segmented control |
| Tabs | `@/components/ui/tabs` → `<Tabs>` + `TabsList` / `TabsTrigger` / `TabsContent` | custom tab bars |
| Select | `@/components/ui/select` → `<Select>` + parts | custom picker menus |
| Dropdown menu | `@/components/ui/dropdown-menu` → `<DropdownMenu>` + parts | custom action menus |
| Context menu | `@/components/ui/context-menu` → `<ContextMenu>` + parts | custom long-press menus |
| Popover | `@/components/ui/popover` → `<Popover>` + parts | custom anchored overlays |
| Hover card | `@/components/ui/hover-card` → `<HoverCard>` + parts | custom hover/preview overlays |
| Tooltip | `@/components/ui/tooltip` → `<Tooltip>` + parts | custom tooltip overlays |
| Progress | `@/components/ui/progress` → `<Progress>` | custom progress bars |
| Separator | `@/components/ui/separator` → `<Separator>` | ad-hoc `border-b` / hairline `View`s |
| Aspect ratio | `@/components/ui/aspect-ratio` → `<AspectRatio>` | manual width/height ratio math |
| Faded scroll | `@/components/ui/faded-scroll-view` → `<FadedScrollView>` | custom fade-mask `ScrollView` |
| Safe area | `@/components/ui/safe-area-view` → `<SafeAreaView>` | raw `react-native-safe-area-context` wrappers with duplicated insets |

Plurality rule: if you find yourself writing the same `className` string on more
than one `<Text>`, you are doing it wrong — that styling already exists as a
`Text` variant. Add a variant to `text.tsx` before inlining.

## Text — use the variants, not custom CSS

`components/ui/text.tsx` already sets `font-roobert text-foreground` on the base.
Pick a `variant`; do not restate size/weight/color with classes.

| variant | Purpose | Style |
| --- | --- | --- |
| `h1` | Page hero heading | `text-4xl font-extrabold tracking-tight` |
| `h2` | Section heading (with bottom border) | `text-3xl font-semibold tracking-tight` |
| `h3` | Sub-section heading | `text-2xl font-semibold tracking-tight` |
| `h4` | Card / group heading | `text-xl font-semibold tracking-tight` |
| `large` | Emphasis / sheet title | `text-lg font-semibold` |
| `p` | Body paragraph | `leading-7` |
| `small` | Dense label / inline action | `text-sm font-medium leading-none` |
| `muted` | Secondary / helper text | `text-muted-foreground text-sm` |
| `label` | Field label / eyebrow | `text-xs font-medium leading-none` |
| `lead` | Intro line | `text-muted-foreground text-xl` |
| `code` | Inline code | mono, `text-sm` |
| `default` | Plain body | `text-base` |

- ✅ `<Text variant="muted">Forgot your password?</Text>`
- ❌ `<Text className="font-roobert text-[13px] text-muted-foreground">…`
- Inside a `<Button>`, just render `<Text>…</Text>` — the button styles it via `TextClassContext`.
- Only add a `className` to `Text` for **layout** (`mt-3`, `text-center`) or a genuinely one-off color on a fixed-palette surface (e.g. always-dark hero). Never for size/weight that a variant already encodes.

## Button

`components/ui/button.tsx` is `rounded-full` by default. Variants: `default`,
`secondary`, `secondary-outline`, `outline`, `ghost`, `accent`, `card`, `link`,
`transparent`. Sizes: `default`, `sm`, `lg`, `icon`. Children are styled through
`TextClassContext`, so pass a plain `<Text>` (and `<Icon>`) as children.
There is **no** `blue` variant — use `variant="default"` for the primary action.

## Input / Textarea

- `<Input>` — props are `TextInputProps` + `variant?: 'default' | 'transparent'`.
  `default` = filled `rounded-2xl bg-card`; `transparent` = bordered `rounded-md`.
  It is a plain controlled `TextInput` (not `forwardRef`) — do **not** rely on
  `ref` focus-chaining; use `returnKeyType` + `onSubmitEditing`.
- `<Textarea>` — multiline `rounded-2xl bg-card` field.

## Do / Don't

- ✅ One source of truth per primitive; extend the primitive when it lacks something.
- ✅ `Text` variants for every size/weight/secondary-color decision.
- ✅ Prefer the table above for overlays, menus, form controls, and layout chrome.
- ❌ Re-declaring `font-roobert`, `text-[NNpx]`, `text-muted-foreground`, `text-sm`, etc. on `Text`.
- ❌ New per-screen input/button/sheet/dialog/menu wrappers that duplicate these.
- ❌ Raw `react-native` `Text`/`TextInput`/`Pressable`/`Switch`/`Modal` for styled UI.

## When you change a primitive's API

If you change any file under `components/ui/` (especially `input.tsx` /
`button.tsx` / `text.tsx` / `sheet.tsx`), update **every consumer** in the same
change (grep the imports) — a simplified primitive that drops props silently
breaks the screens that still pass them.
