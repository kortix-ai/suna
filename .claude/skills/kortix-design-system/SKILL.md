---
name: kortix-design-system
description: "Kortix brand + design system: the rules, tokens, and component library for building any Kortix frontend UI (apps/web). Load this WHENEVER you create or edit a page, screen, component, list, card, badge, avatar, modal, form, empty state, or any visual surface in apps/web — and whenever deciding whether to reuse an existing component or add a new one. Enforces: always import from the design system, never hand-roll chrome, people-are-round / things-are-square avatars, and one standardized brand identity. Source of truth is globals.css + the live /design-system page + src/components/ui."
---

# Kortix Design System

The single reference for building Kortix UI. **If you are touching a visual surface in `apps/web`, follow this.** The goal is one standardized, simple, recognizable brand identity — achieved by _always composing the design system_ instead of hand-rolling.

## Philosophy

- **Simplicity is the brand.** Black & white + one accent color. Calm, dense, legible. No decoration that doesn't carry information.
- **The design system is the source of truth.** Everything imports from `@/components/ui/*` and the tokens in `globals.css`. A screen should read like a sentence built from shared words.
- **AI-native & self-documenting.** The living styleguide at **`/design-system`** (`apps/web/src/app/(home)/design-system/page.tsx`) renders _every_ component. When you add a component, you add it there too — so the system can never drift from its documentation.

## The one rule that matters

> **Reuse > Compose > Create.** In that order. Never hand-roll something the system already provides.

Decision flow when you need a UI piece:

1. **Reuse** — does a component in `src/components/ui/` already do this? Use it. (Check the list below and the `/design-system` page first.)
2. **Compose** — can you build it from existing primitives + tokens? Do that (this is how `SectionCard` is just `Card` + a header).
3. **Create** — only if 1 and 2 fail. Then:
   - Put it in `src/components/ui/<name>.tsx`, built from tokens and existing primitives.
   - Keep the API tiny and prop-driven; match the conventions of neighboring files.
   - **Add a showcase block to `/design-system`** (a nav entry in `TOC_SECTIONS` + a `<div id="pat-…">` block with `ComponentLabel`/`ComponentDesc`/`DemoContainer`). If it's not on the page, it doesn't exist.

## Tokens — `globals.css` is law

For `apps/web`, **`apps/web/src/app/globals.css` is the implementation source of truth** for color, typography, radius, spacing, shadows, borders, and motion. `brand-guidelines` explains the brand intent (neutral base, one accent per surface, Roobert, subtle shadows); if a value conflicts, `globals.css` wins. Use semantic Tailwind tokens, never raw hex/OKLCH/RGB values and never one-off arbitrary radii or font sizes.

- **Color tokens:** use the implemented tokens exposed in `@theme inline`: `background/foreground`, `card/card-foreground`, `popover/popover-foreground`, `primary/primary-foreground`, `secondary/secondary-foreground`, `muted/muted-foreground`, `accent/accent-foreground`, `destructive/destructive-foreground`, `border`, `input`, `ring`, `sidebar-*`, `chart-1`…`chart-5`, and brand accents `kortix-base`, `kortix-blue`, `kortix-yellow`, `kortix-orange`, `kortix-green`, `kortix-purple`, `kortix-red`. In components, write classes like `bg-background`, `text-foreground`, `bg-card`, `text-muted-foreground`, `border-border`, `ring-ring`, `bg-kortix-blue`. **Never** use raw Tailwind palette classes (`bg-blue-500`, `text-red-400`, `bg-green-600`, `border-amber-300`, etc.), raw values (`#fff`, `oklch(...)`, `rgb(...)`), or hardcoded theme hacks (`bg-black/10`, `bg-white/10`).
- **Accent discipline:** the app is neutral first. Use one `kortix-*` accent per surface when content needs color; use `chart-*` only for data visualization. For normal app selection and activity, prefer `primary` tint (`bg-primary/[0.05]`–`bg-primary/[0.10]`, `text-primary`, `border-l-primary`) over flat grey fills.
- **Red is the brake, not the paint.** `destructive`/red is reserved for the _single irreversible confirmation step_ — the primary button inside a `ConfirmDialog`/`AlertDialog`. **Never** color routine actions red: Log out, Cancel, Close, navigation, and every menu **row** (even `Remove` / `Leave` / `Delete` entries) stay neutral and only turn red at the final confirm. Red sprinkled on menus and links reads as noise and looks off — restraint is the brand.
- **A Danger Zone stays calm.** `SectionCard tone="destructive"` is a _neutral_ panel with only a faint warm hairline edge (`border-destructive/25`) — its title and description read normally (no red text, no red fill), and its trigger button is **neutral** (e.g. `variant="outline"`) because it just opens a confirm. The single red lives on that final confirm button — never on the panel, the title, or the trigger. A panel painted red is the #1 thing that makes the product look aggressive; don't.
- **Selected / active = tinted primary, never flat grey.** The brand is monochrome, so a flat grey fill used to mean "selected"/"active" reads as an accidental smudge. Active toggles, selected tabs, and "on" pills use `variant="subtle"` (`bg-primary/10 text-primary`), never `variant="secondary"` or `bg-muted`. Selected rows/cards use `bg-primary/[0.05]`–`bg-primary/[0.08]`, optionally with `border-l-2 border-l-primary`. Dense command/menu rows use the primitive's `data-[selected=true]:bg-foreground/[0.06]`. Image scrims/overlays use `bg-foreground/[0.06]`.
- **Typography:** `--font-sans` maps to `var(--font-roobert)` and `--font-mono` maps to `var(--font-roobert-mono)`. Use `font-sans` for UI, headings, and body; use `font-mono` only for code, paths, IDs, CLI/config nouns, and technical snippets. Fallbacks and CJK handling live in `globals.css`; do not override them per component.
- **Type scale:** keep `html` at `font-size: 100%`; never simulate zoom by changing root size. Use named text tokens only: `text-xs` = metadata/captions/badges/timestamps; `text-sm` = dense UI rows, menus, compact buttons, sidebar labels; `text-base` = readable body, form text, chat/content; `text-lg` through `text-8xl` = page hierarchy, marketing, and display. Section titles are `text-base font-semibold`; row titles are `text-sm font-medium` unless content-heavy, then `text-base`.
- **Typography details:** `globals.css` defines line-height tokens for every text size, `--tracking-normal: 0em`, antialiasing, `text-rendering: optimizeLegibility`, and Roobert feature settings (`ss10`, `ss09`, `ss03`, `ss04`, `ss14`, `palt`). Do not loosen body tracking or add arbitrary type utilities like `text-[10px]`, `text-[13.5px]`, or `text-[0.875em]`. Syntax/color utilities such as `text-[var(--shiki-dark)]` are allowed because they are colors, not font sizes.
- **Navigation hierarchy:** Parent/child rows stay on the same readable title size (`text-sm` in dense sidebars). Show hierarchy with indentation, a border, a dot/icon, opacity, or metadata treatment — not by shrinking child titles below the parent.
- **Radius:** use only the implemented radius tokens from `globals.css` (`rounded-sm`, `rounded-md`, `rounded-lg`, `rounded-xl`, `rounded-2xl`) plus `rounded-md`. App chrome convention: main containers, cards, panels, dialogs, inputs, textareas, selects, popovers, dropdown/context menus, command palettes, tables, banners, alerts, and selectable option cards use `rounded-2xl`. Pills (buttons, badges) use `rounded-full`. Menu/list highlight rows use `rounded-lg`; tiny micro-bits (kbd keys, swatches, ≤24px icon squares) may use the smaller token that matches the primitive. Never use arbitrary radii like `rounded-[5px]`.
- **Form controls:** `Input`, `Textarea`, `Select` share ONE treatment — `bg-card`, `border`, `rounded-2xl`, accent focus ring (`focus:ring-2 focus:ring-primary/50`), no shadow. `Input` is canonical; the other two mirror it. **Never** restyle a field per-usage (no per-field `bg-transparent`, `shadow-xs`, or a custom/neutral focus ring).
- **Spacing and borders:** use Tailwind spacing utilities backed by `--spacing: 0.23rem`; use `--spacing-sidebar` and desktop/titlebar inset variables only in shell chrome. Border color comes from `border-border`; border thickness follows the design-system components and the `--border-width` token where a primitive uses it. Do not invent heavier strokes.
- **Shadows:** shadows exist but stay subtle. Use the implemented `shadow-2xs`…`shadow-2xl` tokens only when elevation is needed; most controls and dense app surfaces should remain flat. Never add glow, neon, colored shadows, or custom `box-shadow` values.
- **Motion:** use duration/easing tokens from `globals.css`: `duration-fast` 100ms, `duration-normal` 150ms, `duration-moderate` 200ms, `duration-slow` 300ms, `duration-slower` 500ms; `ease-default`, `ease-in`, `ease-out`, `ease-in-out`. Default UI transitions are 150–200ms with `ease-default` or `ease-out`; repeated keyboard-driven actions should not animate.

## Component catalog — what to use when

Surfaces & layout

- **`SectionCard`** — THE panel. Composes `Card` (rounded-2xl) + a divided header (`title`, muted `count`, `description`, trailing `action`). `flush` seats a `List` edge-to-edge; `tone="destructive"` is the danger zone (a calm neutral panel with a faint warm edge — not a red box). Use this instead of any `<section className="rounded-xl border …">`.
- **`Card` / `CardHeader` / `CardContent`** — raw surface when `SectionCard` is too opinionated.
- **`Section`** — labelled, _boxless_ grouping inside a `PageShell` (uppercase micro-label + whitespace).
- **`PageShell` / `PageHeader`** — page width + intro.

Lists & rows

- **`List` + `ListRow`** — THE list. `ListRow` has a `leading` slot (avatar/icon), `title` + inline `badges`, a `subtitle` (use `InlineMeta`), and a `trailing` slot (status badge + kebab). A clickable row is an accessible `div role="button"` so it can still hold a trailing menu (wrap that menu in `stopPropagation`). Use this instead of hand-rolled `<ul className="divide-y">`.
- **`Table` / `DataTable`** — only for genuinely multi-column tabular data. Lists beat tables for entity rows.
- **`DefinitionList` / `DefinitionRow`** — key/value detail panels.

Identity

- **`UserAvatar`** — a **person** (round). Renders the supabase profile picture when present (`avatar_url`/`picture`, `referrerPolicy="no-referrer"`), else neutral monochrome initials — **no colored backgrounds**. People and things share the same neutral material and size scale; only the shape differs. Pending invites are people too → `UserAvatar` by email.
- **`EntityAvatar`** — a **thing**: account, project, group, workspace (rounded square; initial or Lucide `icon`). **People are round, things are square — never mix.** Both share the `xs|sm|md|lg|xl` scale so they align.

Atoms

- **`Badge`** — status chips. Use `variant` (`outline|secondary|destructive|success|…`) + `size="sm"` for dense UI. **Never** hand-roll `h-4 rounded-md px-1 text-[9px]`.
- **`Button`** — pill (`rounded-md`) by default. Sizes `sm|default|lg|icon`. Variants `default|outline|ghost|destructive|secondary|subtle`.
- **`InlineMeta`** — the `a · b · c` fact strip (skips falsy children). Use for row subtitles & header meta instead of manual `·`/`/` separators.
- **`InfoBanner`** — inline status / note box (manifest status, warnings, tips, the live diff preview). `tone` = `neutral|info|success|warning|destructive` + optional `icon`, `title`, `action`. Use this instead of hand-rolling `rounded-md border border-amber-500/30 bg-amber-500/5` colored one-offs. (`Alert` is the heavier, role-flagged full-width variant.)
- **`EmptyState`** — zero-state: icon + title + description + up to two actions. Use for every empty list.
- **`Tabs`** (+ `TabsListCompact`) — pill tabs.
- **`Skeleton`** — loading; match the shape it replaces (round vs `rounded-lg`).

## Dos & Don'ts

- ✅ Panels → `SectionCard`. ❌ `<section className="rounded-xl border border-border/70 bg-card">` with a hand-rolled header.
- ✅ Danger zones → `<SectionCard tone="destructive">`. ❌ a bespoke red box.
- ✅ Destructive intent → a **neutral** trigger (menu row / button) that opens a confirm; red appears **only** on that final confirm button. ❌ `text-destructive` on Log out, Cancel, links, or menu rows.
- ✅ People → `UserAvatar` with neutral initials / real photo. ❌ a colored avatar background or white-on-color initials.
- ✅ Lists → `List` + `ListRow`. ❌ ad-hoc `<ul className="divide-y">` with custom `<li>` flex rows.
- ✅ Badges → `<Badge size="sm" variant="…">`. ❌ `className="h-4 rounded-md px-1 text-[9px]"`.
- ✅ People → `UserAvatar` (round); things → `EntityAvatar` (square). ❌ a custom initial tile, or a circle for a project / a square for a person.
- ✅ Meta lines → `InlineMeta`. ❌ manual `<span className="text-muted-foreground/40">·</span>`.
- ✅ Empty views → `EmptyState`. ❌ centered `<p>` with custom padding.
- ✅ Status / note boxes → `<InfoBanner tone="…">`. ❌ `<div className="rounded-md border border-amber-500/30 bg-amber-500/5 …">` colored one-offs.
- ✅ Form fields → bare `Input`/`Textarea`/`Select` (they already match). ❌ a per-field `bg-transparent`, `shadow-xs`, or custom focus ring that makes two fields look like different materials.
- ✅ Font sizes → named text tokens (`text-xs`, `text-sm`, `text-base`, `text-lg`+). ❌ arbitrary font-size classes like `text-[11px]`, `text-[13.5px]`, or `text-[0.875em]`.
- ✅ Nested nav/session rows → same readable title token, with indentation/dot/border for hierarchy. ❌ child titles made smaller than parent titles.
- ✅ Color/radius via `globals.css` tokens (`bg-muted`, `bg-kortix-blue`, `rounded-2xl`). ❌ Tailwind palette colors (`bg-blue-500`, `text-red-400`, `bg-green-600`), raw values (`#fff`, `oklch(…)`), `rounded-[5px]`, `rounded-md`/`rounded-xl` on a container.
- ✅ Selected/active → tinted primary (`variant="subtle"`, `bg-primary/[0.05]`, `border-l-primary`). ❌ a flat grey selected/active state (`variant="secondary"`, `bg-muted`, hardcoded `bg-black/10`).
- ✅ Modals: header `border-b`, padded body, **flush footer bar** (`flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3`). ❌ `-mx-6`/`mt-4` hacks or leftover bottom padding under the footer.
- ✅ One shared component imported everywhere. ❌ a second copy of an existing component (e.g. a local `CreateAccountModal`).

## Modal pattern (canonical)

```tsx
<DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
  <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4"> … </DialogHeader>
  <form onSubmit={…}>
    <div className="space-y-4 px-6 py-5"> {/* fields */} </div>
    <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
      <Button variant="ghost">Cancel</Button>
      <Button type="submit">Confirm</Button>
    </div>
  </form>
</DialogContent>
```

## Workflow checklist

1. Open `/design-system` (run the app, see `kortix-design-system`/run skills) and skim `src/components/ui/` before writing UI.
2. Build the screen by composing primitives — `SectionCard` + `List`/`ListRow` + `UserAvatar`/`EntityAvatar` + `Badge` + `InlineMeta` + `EmptyState`.
3. If you must create a primitive: build it from tokens, keep it tiny, and add a showcase block to `/design-system`.
4. Verify: no hardcoded colors/radii, no hand-rolled chrome, correct avatar shapes, themes still work, `tsc` clean for the files you touched.

The reference implementation that follows all of the above: the account screens (`src/app/accounts/**`) and the IAM components (`src/components/iam/**`).
