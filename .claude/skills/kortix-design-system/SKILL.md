---
name: kortix-design-system
description: "Kortix brand + design system: the rules, tokens, and component library for building any Kortix frontend UI (apps/web). Load this WHENEVER you create or edit a page, screen, component, list, card, badge, avatar, modal, form, empty state, toast, tooltip, or any visual surface in apps/web. Source of truth: globals.css + the live /design-system page + src/components/ui + the reference implementations listed below."
---

# Kortix Design System

**If you are touching a visual surface in `apps/web`, follow this.** This skill was rewritten in June 2026 to match the polished reference implementations — the old version is stale and superseded.

## Philosophy

- **Simplicity is the brand.** Black & white + one accent. Calm, spacious, legible. No decoration that doesn't carry information. Show only important data.
- **Reuse > Compose > Create.** In that order. Never hand-roll something the system already provides.
- **Tokens are law.** `apps/web/src/app/globals.css` is the implementation source of truth for every visual property. If a value conflicts with anything else, `globals.css` wins.
- **AI-native & self-documenting.** The living styleguide at `/design-system` renders every component. When you add a component, add it there too.

## Strictly avoid — deprecated primitives

**Do not use these in new work or when refactoring screens.** They are legacy wrappers; match the hand-composed patterns in the reference implementations instead.

- **`SectionCard`** (`apps/web/src/components/ui/section-card.tsx`) — use `Card` + explicit header markup (see `settings-view.tsx`, `agents-view.tsx`) instead.
- **`List` / `ListRow`** (`apps/web/src/components/ui/list.tsx`) — compose entity rows inside a `Card` or flush container with `divide-border/60 divide-y` and the row layout from reference views. Never import `List` or `ListRow`.

When editing a file that already uses them, prefer migrating to the reference pattern over adding more usage.

## Reference implementations — read these before building a new screen

These files are the new source of truth for what good looks like. Match their patterns.

- **Shell + responsive layout:** `apps/web/src/features/workspace/customize/customize-panel.tsx` + `sections/component/section-wrapper.tsx`
- **List/card composition, flush rows, no nested rounding:** `apps/web/src/features/workspace/customize/sections/view/agents-view.tsx`, `apps/web/src/features/workspace/customize/sections/view/settings-view.tsx`
- **Tinted-icon status pattern:** `apps/web/src/components/projects/schedule-view.tsx`
- **Table + badges + header:** `apps/web/src/features/workspace/customize/sections/view/secrets-view.tsx`
- **Sidebar chrome:** `apps/web/src/features/workspace/project-sidebar/project-sidebar.tsx` + `apps/web/src/components/sidebar/sidebar-left.tsx`

## Layout & responsiveness

**Canonical section wrapper pattern** (from `section-wrapper.tsx`):

```tsx
<div className="flex h-full min-h-0 flex-col">
  <div className="min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto w-full max-w-2xl space-y-5 px-4 py-20">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-foreground text-xl font-medium">{title}</h2>
          <p className="text-muted-foreground text-sm text-balance">
            {description}
          </p>
        </div>
        {action} {/* button/control on the right */}
      </header>
      {children}
    </div>
  </div>
</div>
```

Rules:

- **Header:** label/title + description on the left, action button on the right. Stacks vertically on mobile (`flex-col sm:flex-row`). Always.
- **Content below** the header, never beside it.
- **Page section padding:** `py-20` for breathable sections; `space-y-5` between sections.
- **Container:** `mx-auto w-full max-w-2xl` keeps content readable and centered.
- Mobile-first: every layout must be tested at narrow width.

## Tokens — `globals.css` is law

### Color

Use only semantic tokens and `kortix-*` brand accents. **Never** raw Tailwind palette classes (`bg-blue-500`, `text-red-400`, `bg-emerald-600`, `border-amber-300`), raw values (`#fff`, `oklch(...)`, `rgb(...)`), or manual theme hacks (`bg-black/10`, `bg-white/10`, `dark:bg-emerald-400`).

**Semantic tokens:** `background/foreground`, `card/card-foreground`, `popover/popover-foreground`, `primary/primary-foreground`, `secondary/secondary-foreground`, `muted/muted-foreground`, `accent/accent-foreground`, `destructive/destructive-foreground`, `border`, `input`, `ring`, `sidebar-*`, `chart-1`…`chart-5`.

**Brand accents (`kortix-*`):** `kortix-base`, `kortix-blue`, `kortix-yellow`, `kortix-orange`, `kortix-green`, `kortix-purple`, `kortix-red`. These are the _only_ color sources for semantic UI color (status, icons, tints). No other color names are allowed.

**Semantic palette (status & icon color):**
| State | Token |
|---|---|
| success / running / connected | `kortix-green` |
| error / failed | `kortix-red` |
| warning / needs attention / unsaved | `kortix-orange` |
| pending / soft / informational | `kortix-yellow` |
| paused / idle / neutral | `muted-foreground` |
| data visualization only | `chart-1`…`chart-5` |

**Two-mode design (light + dark):** every color must work in both. Use semantic tokens that auto-flip — they are defined in `.dark {}` in `globals.css`. Never hard-code a single-mode color or add a manual `dark:` palette class (`dark:text-emerald-400`). The only allowed `dark:` uses are for shadow and sidebar-specific overrides already in primitives.

**Active / selected = tinted primary, never flat grey:**

- Selected rows/cards: `bg-primary/[0.05]`–`bg-primary/[0.08]`, optionally `border-l-2 border-l-primary`.
- Active toggles, pills, tabs: `variant="subtle"` (`bg-primary/10 text-primary`).
- Never `variant="secondary"` or `bg-muted` to mean "selected."

**Destructive / danger semantics:**

- `kortix-red` is allowed on _status icons_ (failed, error) — this is explicit and intentional.
- The `destructive` token (deeper red) is reserved for the _single final confirm button_ inside a `ConfirmDialog`. Never on menu rows, trigger buttons, labels, or routine actions like Log out / Cancel.
- A Danger Zone panel stays neutral — faint warm edge only (`border-kortix-orange/20` or similar), no red fill or red text on the panel itself. Do not use `SectionCard`; compose with `Card` like `settings-view.tsx`.

### Radius

**Default container radius: `rounded-md`.** (The old skill's `rounded-2xl` for containers is superseded.)

| Surface                                                  | Radius         |
| -------------------------------------------------------- | -------------- |
| Main containers, cards, panels, dialogs, tables, banners | `rounded-md`   |
| Flush / edge-to-edge seams inside a container            | `rounded-none` |
| Menu/list highlight rows                                 | `rounded-md`   |
| Status icon tiles (`size-8` tinted squares)              | `rounded-sm`   |
| Inputs, textareas, selects                               | `rounded-lg`   |
| Pills (buttons, badges)                                  | `rounded-full` |
| Tiny micro-bits (kbd, swatches, ≤24px icon squares)      | `rounded-sm`   |

**Never:** arbitrary radii (`rounded-[5px]`), `rounded-xl`, `rounded-2xl` on containers, or two levels of rounding nested inside each other (a rounded child inside a rounded parent — use `rounded-none` for the inner piece).

### Spacing & padding

- **No direct padding on a Card/panel.** The card owns the border + radius; padding lives on inner content containers.
- Inner section padding: `px-4 py-5` (standard), `px-3 py-6` (compact with centered content).
- Vertical rhythm between items: `space-y-1`, `space-y-2`, `space-y-2.5`, `space-y-4`, `space-y-5`. Don't invent off-scale values.
- Row gaps: `gap-1`, `gap-1.5`, `gap-2`. Section-level gaps: `gap-2`, `gap-4`, `gap-5`.
- Spacing utilities are backed by `--spacing: 0.23rem`; don't override per-component.

### Typography

- `font-sans` for all UI, headings, body. `font-mono` only for code, paths, IDs, CLI nouns.
- Named text tokens only: `text-xs` (metadata/badges/timestamps), `text-sm` (dense rows, menus, sidebar), `text-base` (body, forms, chat), `text-lg`+ (page hierarchy, display).
- Section titles: `text-base font-semibold`. Row titles: `text-sm font-medium`.
- No arbitrary font sizes: `text-[11px]`, `text-[13.5px]`, `text-[0.875em]` — all banned.
- Navigation hierarchy: show it with indentation, border, dot/icon, or opacity — not by making child titles smaller than parent titles.

### Shadows & motion

- Shadows stay subtle. Use `shadow-2xs`…`shadow-2xl` tokens only when elevation is genuinely needed. Most app surfaces are flat.
- Motion tokens: `duration-fast` 100ms, `duration-normal` 150ms, `duration-moderate` 200ms, `duration-slow` 300ms; `ease-default`, `ease-out`. Default transitions: 150–200ms `ease-default`. Repeated keyboard actions don't animate.

## Status pattern — tinted icon tile

**Never show status as a plain text label or an in-patch `<Badge>` when an icon can carry the meaning.**

Canonical pattern (from `schedule-view.tsx`):

```tsx
<div
  className={cn(
    "inline-flex size-8 shrink-0 items-center justify-center rounded-sm border",
    isRunning && "bg-kortix-green/10 text-kortix-green",
    isFailed && "bg-kortix-red/10   text-kortix-red",
    isPaused && "bg-kortix-orange/10 text-kortix-orange",
    isIdle && "text-muted-foreground border-border",
  )}
>
  <SomeSolidIcon className="size-5 shrink-0" />
</div>
```

Rules:

- `size-8 rounded-sm border` — the tile shape is fixed.
- Color = `bg-kortix-{c}/10 text-kortix-{c}` — tint background + matching icon color.
- Use a **solid** icon variant (not outline) so color reads clearly at small sizes.
- Text label underneath only when the icon alone is ambiguous.

## Component catalog — what to use when

### Surfaces & layout

- **`CustomizeSectionWrapper`** (`sections/component/section-wrapper.tsx`) — THE section shell for customize-panel views. Title left, action right, responsive.
- **`Card` / `CardHeader` / `CardContent`** — panels and grouped content. Compose headers with title, count, description, and trailing action inline (see `settings-view.tsx`). **Not** `SectionCard`.
- **`PageShell` / `PageHeader`** — page width + intro.

### Lists & rows

- **Hand-composed rows in `Card`** — entity lists: `divide-border/60 divide-y` container, each row with `leading` (avatar/icon), `title` + `badges`, `subtitle` (`InlineMeta`), `trailing` (status + kebab). Clickable rows are `div role="button"`; wrap trailing menus in `stopPropagation`. Copy structure from `agents-view.tsx` / `settings-view.tsx`. **Not** `List` / `ListRow`.
- **`Table` / `DataTable`** — only for genuinely multi-column tabular data.
- **`DefinitionList` / `DefinitionRow`** — key/value detail panels.

### Identity

- **`UserAvatar`** — person (round). Supabase profile picture or neutral monochrome initials — no colored backgrounds. Pending invites are people → `UserAvatar`.
- **`EntityAvatar`** — thing: account, project, group, workspace (rounded square). **People are round, things are square — never mix.**

### Atoms

- **`Badge`** — status chips. `variant` + `size="sm"` for dense UI. Never hand-roll a badge.
- **`Button`** — `rounded-md`. Sizes `sm|default|lg|icon`. Variants `default|outline|ghost|destructive|secondary|subtle`.
- **`InlineMeta`** — `a · b · c` fact strip (skips falsy children). Use for row subtitles instead of manual `·` separators.
- **`InfoBanner`** — inline status/note box. `tone` = `neutral|info|success|warning|destructive`. Use instead of hand-rolled colored `<div>` banners.
- **`EmptyState`** — zero-state: icon + title + description + ≤2 actions. Use for every empty list.
- **`Tabs`** / **`TabsListCompact`** — pill tabs.
- **`Skeleton`** — loading placeholder; match the shape it replaces.

### Feedback

- **`toast`** (`@/components/ui/toast`) — import `successToast`, `errorToast`, `infoToast`, `warningToast`, `progressToast`, `loadingToast` from here only. Never `sonner`, `@/lib/toast`, or `toast.custom()`.
- **`Hint`** (`@/components/ui/hint`) — `<Hint label="…">…</Hint>`. Never import `Tooltip`/`TooltipTrigger`/`TooltipContent` in feature code.

## Modal pattern (canonical)

```tsx
<DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
  <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4"> … </DialogHeader>
  <form onSubmit={…}>
    <div className="space-y-4 px-6 py-5">{/* fields */}</div>
    <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
      <Button variant="ghost">Cancel</Button>
      <Button type="submit">Confirm</Button>
    </div>
  </form>
</DialogContent>
```

- Header `border-b`, padded body, flush footer with `bg-muted/30`.
- No `-mx-6`/`mt-4` hacks. No leftover bottom padding under the footer.

## Dos & Don'ts

- ✅ Section shells → `CustomizeSectionWrapper`. ❌ a hand-rolled `<div className="flex flex-col px-… py-…">` with ad-hoc headers.
- ✅ Panels → `Card` + composed header/body. ❌ `SectionCard`, or `<section className="rounded-xl border border-border/70 bg-card">`.
- ✅ Danger zone trigger → neutral button that opens a confirm. ❌ a red trigger button, red menu row, or `text-destructive` on routine actions.
- ✅ Status → tinted icon tile (`bg-kortix-{c}/10 text-kortix-{c} rounded-sm`). ❌ plain text labels or raw-color icon classes.
- ✅ Color → `kortix-*` tokens only (`kortix-green`, `kortix-red`, `kortix-orange`, …). ❌ `text-emerald-600`, `bg-amber-500`, `dark:text-emerald-400`.
- ✅ Container radius → `rounded-md`. Flush seam → `rounded-none`. ❌ `rounded-2xl` or `rounded-xl` on containers, nested rounding.
- ✅ Padding on inner content div. ❌ padding directly on the Card/panel element.
- ✅ Entity rows → hand-composed rows in `Card` (`divide-y`, reference views). ❌ `List` / `ListRow`, or ad-hoc `<ul>` without matching reference spacing.
- ✅ Badges → `<Badge size="sm" variant="…">`. ❌ `className="h-4 rounded-md px-1 text-[9px]"`.
- ✅ People → `UserAvatar` (round); things → `EntityAvatar` (square). ❌ mixing shapes.
- ✅ Meta → `InlineMeta`. ❌ manual `<span className="text-muted-foreground/40">·</span>`.
- ✅ Empty views → `EmptyState`. ❌ centered `<p>` with custom padding.
- ✅ Status/note boxes → `<InfoBanner tone="…">`. ❌ `<div className="rounded-md border border-amber-500/30 bg-amber-500/5">`.
- ✅ Font sizes → named tokens (`text-xs`, `text-sm`, `text-base`). ❌ `text-[11px]`, `text-[13.5px]`.
- ✅ Selected/active → `bg-primary/[0.05]` or `variant="subtle"`. ❌ `bg-muted` or `variant="secondary"` to mean selected.
- ✅ Toasts → named helpers from `@/components/ui/toast`. ❌ `sonner`, raw `toast.success()`.
- ✅ Hints → `<Hint>` from `@/components/ui/hint`. ❌ `Tooltip` primitives in feature code.

## Workflow checklist

1. **Read a reference implementation** first (list above). Match its structure.
2. Open `/design-system` and skim `src/components/ui/` before writing UI.
3. Compose: `CustomizeSectionWrapper` → `Card` + hand-composed rows (or `Table`) → `Badge` + `InlineMeta` + `EmptyState`. Never `SectionCard` or `List`.
4. Status → tinted icon tile. Color → `kortix-*` token. Radius → `rounded-md` (container), `rounded-none` (flush seam).
5. If you must create a primitive: tokens only, tiny API, add a showcase block to `/design-system`.
6. Verify: no raw palette colors, no nested rounding, no direct card padding, both light + dark themes work, `tsc` clean.
