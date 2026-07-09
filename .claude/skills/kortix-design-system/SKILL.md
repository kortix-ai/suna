---
name: kortix-design-system
description: "Kortix brand + design system: the rules, tokens, and component library for building any Kortix frontend UI (apps/web). Load this WHENEVER you create or edit a page, screen, component, list, card, badge, avatar, modal, form, empty state, toast, tooltip, or any visual surface in apps/web. Always load the companion skill make-interfaces-feel-better (apps/web/.agents/skills/make-interfaces-feel-better/SKILL.md) in the same session — brand/tokens here, polish/motion/haptics there. Source of truth: globals.css + the live /design-system page + src/components/ui + the reference implementations listed below."
---

# Kortix Design System

**Track this file:** `.claude/skills/kortix-design-system/SKILL.md` (mirror: `.cursor/skills/kortix-design-system/SKILL.md`)

**If you are touching a visual surface in `apps/web`, follow this.** This skill was rewritten in June 2026 to match the polished customize-panel reference implementations — older guidance is stale and superseded.

## Companion skill — always load both

**Always invoke [`make-interfaces-feel-better`](../../../apps/web/.agents/skills/make-interfaces-feel-better/SKILL.md) alongside this skill.** They are complementary, not optional alternatives:

| Skill                                | Owns                                                                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| **kortix-design-system** (this file) | Brand, tokens, components, layout shells, color/radius/spacing law, reference implementations                                     |
| **make-interfaces-feel-better**      | Polish: concentric radius, optical alignment, shadows, enter/exit motion, scale-on-press, tabular nums, hit areas, font smoothing |

Load both before writing or reviewing UI. When Kortix rules and polish rules overlap (e.g. border radius, motion), **Kortix tokens win** — then apply the polish skill within those constraints.

## Philosophy

- **Simplicity is the brand.** Black & white + one accent. Calm, spacious, legible. No decoration that doesn't carry information. Show only important data.
- **Reuse > Compose > Create.** In that order. Never hand-roll something the system already provides.
- **Tokens are law.** `apps/web/src/app/globals.css` is the implementation source of truth for every visual property. If a value conflicts with anything else, `globals.css` wins.
- **AI-native & self-documenting.** The living styleguide at `/design-system` renders every component. When you add a component, add it there too.

## Strictly avoid — deprecated primitives

**Do not use these in new work or when refactoring screens.** They are legacy wrappers; match the hand-composed patterns in the customize section views instead.

| Banned | Use instead |
| --- | --- |
| **`SectionCard`** (`apps/web/src/components/ui/section-card.tsx`) | `Label` + `bg-popover rounded-md border` panel, or `Disclosure` — see `settings-view.tsx` |
| **`List` / `ListRow`** (`apps/web/src/components/ui/list.tsx`) | `<ul className="space-y-2">` + entity row classes — see `changes-view.tsx`, `members-view.tsx` |
| **`Dialog` / `DialogContent`** in feature code | **`Modal`** from `apps/web/src/components/ui/modal.tsx` — see `secrets-view.tsx`, `channels-view.tsx` |
| **`Tooltip` / `TooltipTrigger` / `TooltipContent`** in feature code | **`Hint`** from `apps/web/src/components/ui/hint.tsx` |
| **`@/lib/toast`**, raw `sonner`, `toast.custom()` | Named helpers from `apps/web/src/components/ui/toast.tsx` |
| Hand-rolled badge `<span>` chips | **`Badge`** from `apps/web/src/components/ui/badge.tsx` |
| **`Loader2`**, `Loader`, or any icon as a spinner (`lucide-react`, `@mynaui/icons-react`, etc.) | **`Loading`** from `apps/web/src/components/ui/loading.tsx` |
| Hand-rolled `<svg>` spinners, `animate-spin` on non-`Loading` elements | **`Loading`** — animation is built in |

When editing a file that already uses banned primitives, migrate to the reference pattern — do not add more usage.

## Required primitives — use these, not alternatives

These are **mandatory** for their job. Import from the paths below; never reimplement or swap in a different library.

| Job | Import from | Notes |
| --- | --- | --- |
| Tooltips on icon buttons | `apps/web/src/components/ui/hint.tsx` | `<Hint label="…">…</Hint>` — wraps trigger, never Tooltip in features |
| Dialogs / sheets | `apps/web/src/components/ui/modal.tsx` | `Modal`, `ModalContent`, `ModalHeader`, `ModalTitle`, `ModalDescription`, `ModalBody`, `ModalFooter` |
| Toasts | `apps/web/src/components/ui/toast.tsx` | `successToast`, `errorToast`, `infoToast`, `warningToast`, `progressToast`, `loadingToast` |
| Status chips | `apps/web/src/components/ui/badge.tsx` | `size="sm"` or `size="xs"`; variants `outline`, `kortix`, `success`, `destructive`, `beta`, etc. |
| Expand/collapse panels | `apps/web/src/components/ui/disclosure.tsx` | `Disclosure`, `DisclosureTrigger`, `DisclosureContent` — config lists, settings groups |
| Inline alerts | `apps/web/src/components/ui/info-banner.tsx` | `tone` + optional `icon` + `title` |
| Search fields | `apps/web/src/components/ui/input-group.tsx` | `InputGroupSearch` + `InputGroupSearchInput variant="popover"` |
| Forms in panels | `apps/web/src/components/ui/field.tsx` | `Field`, `FieldLabel`, `FieldGroup`, `FieldDescription` |
| Empty / error states | `apps/web/src/features/layout/section/empty-state.tsx`, `error-state.tsx` | `size="sm"` in customize sections |
| Confirm destructive | `apps/web/src/components/ui/confirm-dialog.tsx` | **Mandatory before any destructive mutation** — including `DropdownMenuItem variant="destructive"` items (see `secrets-view.tsx` delete, `gateway-keys.tsx` revoke). Only accepted alternative: the inline Cancel/confirm button swap used for channel disconnects (`channels-view.tsx`). Never mutate from a single click |
| Loading / pending spinners | `apps/web/src/components/ui/loading.tsx` | `import Loading from '@/components/ui/loading'` — default `size-4`; use `className="size-4 shrink-0"` in dense buttons. **Never** `Loader2` or other icons |

Also reach for: `Button`, `ButtonGroup`, `Input`, `Select`, `Switch`, `Skeleton`, `Tabs` / `TabsListCompact`, `Table`, `InlineMeta`, `UserAvatar`, `EntityAvatar`.

## Reference implementations — customize section views

**Read the closest match before building any new screen.** All live under `apps/web/src/features/workspace/customize/sections/view/`.

| File | Pattern to copy |
| --- | --- |
| **`section-wrapper.tsx`** (`sections/component/`) | Section shell: title left, action right, `max-w-2xl`, responsive header |
| **`agents-view.tsx`** | Config entity list: search → `Disclosure` rows → detail panel with `Badge`, `ButtonGroup` + `Hint`, toasts |
| **`skills-view.tsx`** | Same disclosure pattern as agents; `EmptyState` + docs link; `InfoBanner` for 403 |
| **`commands-view.tsx`** | Disclosure trigger uses `Button variant="accent"`; otherwise identical config-entity flow |
| **`settings-view.tsx`** | Form sections: `Label` header → `bg-popover rounded-md border px-4 py-5` panel; `Disclosure` for experimental; danger zone as neutral bordered row |
| **`secrets-view.tsx`** | `Table` + `TabsListCompact` filters + **`Modal`** forms + `DropdownMenu` row actions |
| **`members-view.tsx`** | Entity rows (`MEMBER_ROW`), `UserAvatar`, `InlineMeta`, underline `Tabs`, tab badge counts |
| **`changes-view.tsx`** | Tinted `size-9` icon tiles, `Badge variant="kortix" size="xs"`, row inline actions, `TabsListCompact` |
| **`channels-view.tsx`** | `Table` for integrations, `Modal` for connect flows, `InfoBanner` for connected state |
| **`sandbox-view.tsx`** | Build status rows, `Badge` variants per status, nested `Disclosure` for error details |
| **`dev-view.tsx`** | `Stepper` onboarding, command blocks, minimal bordered panels |
| **`computers-view.tsx`** | Thin wrapper — delegates to `TunnelOverview` |

**Shell:** `apps/web/src/features/workspace/customize/customize-panel.tsx`

**Other references:** tinted-icon tiles → `apps/web/src/components/projects/schedule-view.tsx`; sidebar → `project-sidebar.tsx` + `sidebar-left.tsx`.

## Layout & responsiveness

**Always wrap customize-style sections in `CustomizeSectionWrapper`.** Do not hand-roll the outer shell.

Canonical pattern (from `section-wrapper.tsx`):

```tsx
<div className="flex h-full min-h-0 flex-col">
  <div className="min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto w-full max-w-2xl space-y-5 px-4 py-10 pb-20 lg:py-20">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-foreground text-xl font-medium">{title}</h2>
          <span className="flex items-center gap-1">
            <p className="text-muted-foreground text-sm text-balance">{description}</p>
            {/* optional docs link: Button variant="transparent" asChild */}
          </span>
        </div>
        {action ? <div className="mt-2 shrink-0 sm:mt-0">{action}</div> : null}
      </header>
      {children}
    </div>
  </div>
</div>
```

Rules:

- **Header:** title + description left; primary action right. Stacks on mobile (`flex-col sm:flex-row`). Content always **below** the header.
- **Container:** `mx-auto w-full max-w-2xl`.
- **Section padding:** `py-10 pb-20 lg:py-20`; `space-y-5` between header and body.
- **Major blocks inside body:** `space-y-4` (search + list), `space-y-6` (tab panels), `space-y-8` (settings sections).
- Mobile-first: test narrow width.

## Card & panel patterns (no SectionCard)

Panels are **hand-composed** `bg-popover rounded-md border` surfaces — not `SectionCard`, not raw `Card` with padding on the outer element.

### Settings / form panel

```tsx
<section className="space-y-4">
  <Label>Repository</Label>
  <div className="bg-popover space-y-5 rounded-md border px-4 py-5">
    <FieldGroup className="grid gap-3 sm:grid-cols-2">{/* fields */}</FieldGroup>
  </div>
</section>
```

### Entity row (list item)

```tsx
<ul className="space-y-2">
  <li className="group bg-popover flex items-center gap-3 rounded-md border px-4 py-2 transition-colors">
    {/* leading: size-9 tinted icon tile */}
    {/* body: min-w-0 flex-1 */}
    {/* trailing: Button size="sm" */}
  </li>
</ul>
```

Members use `py-2.5` (`MEMBER_ROW` in `members-view.tsx`). Changes/sandbox use `py-2`.

### Config entity disclosure (agents, skills, commands)

```tsx
<div className="space-y-2">
  <Disclosure variant="outline" className="overflow-hidden" open={open} onOpenChange={setOpen}>
    <DisclosureTrigger variant="outline">
      <Button variant="popover" className="flex w-full items-center justify-start rounded-none">
        <span className="truncate text-sm font-medium">{name}</span>
      </Button>
    </DisclosureTrigger>
    <DisclosureContent variant="outline" contentClassName="border-border border-t">
      <div className="relative px-4 py-5">{/* detail */}</div>
    </DisclosureContent>
  </Disclosure>
</div>
```

Detail header: `text-2xl font-semibold tracking-tight` title; meta `Badge variant="outline" size="sm"`; toolbar `absolute top-4 right-4` with `ButtonGroup` + `Hint`.

### Danger zone (settings)

Neutral bordered row — no red panel fill:

```tsx
<div className="bg-popover rounded-md border px-4 py-3">
  <div className="flex items-center justify-between gap-4">
    <div className="min-w-0">{/* title text-sm font-medium + description text-xs */}</div>
    <Button variant="destructive" size="sm" onClick={openConfirm}>Archive</Button>
  </div>
</div>
```

`destructive` on the button is OK inside `ConfirmDialog` flow; panel itself stays neutral.

## Button conventions

Match the customize views — consistent sizes and variants:

| Context | Pattern |
| --- | --- |
| Section header primary action | `Button size="sm" variant="secondary"` + `Plus` icon (`size-4`) + label; group with `gap-1.5` |
| Empty state CTA | `Button variant="outline" size="sm" className="gap-1.5"` |
| Docs / secondary link | `Button asChild variant="ghost" size="sm" className="gap-1.5"` |
| Row secondary action | `Button variant="ghost" size="sm"` |
| Row primary action | `Button size="sm"` (default variant) |
| Icon-only with tooltip | `Hint` → `Button variant="outline" size="icon"` inside `ButtonGroup` |
| Inline text link | `Button variant="transparent" size="sm" asChild` |
| Modal cancel | `Button variant="outline-ghost"` |
| Pending / in-flight state | `<Loading className="size-4 shrink-0" />` in buttons; `<Loading />` or `className="size-4 shrink-0"` in headers — **never** `Loader2` |

Icons in buttons: `size-3.5 shrink-0` (dense) or `size-4` (header). Always `shrink-0` on icons. **Exception:** loading uses `Loading`, not an icon import.

## Button icon-swap — buttery transitions (blur + scale + opacity)

When a button swaps its icon on a state change (copy → copied, play → pause, follow → following), **never hard-swap** `{done ? <Check/> : <Copy/>}`. Cross-fade the two icons in the same box with **blur + scale + opacity** so it reads as one morph, not two objects blinking. `motion` (`motion/react`) is already a dependency — use it.

Exact values (from [`make-interfaces-feel-better`](../../../apps/web/.agents/skills/make-interfaces-feel-better/SKILL.md) → Contextual icon animations): **scale `0.25 → 1`, opacity `0 → 1`, blur `4px → 0`**, spring **`{ type: 'spring', duration: 0.3, bounce: 0 }`** (`bounce: 0` keeps it buttery, never playful). Always `initial={false}` so nothing animates on first paint.

```tsx
import { AnimatePresence, motion } from 'motion/react';

<button
  onClick={handleCopy}
  aria-label={copied ? 'Copied' : 'Copy'}
  className={cn(
    'inline-flex size-7 items-center justify-center rounded-md',
    'text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10',
    'cursor-pointer transition-colors active:scale-[0.97]', // press feedback compounds with the swap
  )}
>
  <span className="relative inline-flex size-3.5 items-center justify-center">
    <AnimatePresence initial={false} mode="popLayout">
      <motion.span
        key={copied ? 'check' : 'copy'}
        initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
        animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
        exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
        transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
        className="absolute inset-0 inline-flex items-center justify-center"
      >
        {copied ? <Check className="size-3.5 text-kortix-green" /> : <Copy className="size-3.5" />}
      </motion.span>
    </AnimatePresence>
  </span>
</button>
```

Rules: both icons share one fixed-size box (`relative size-3.5` parent, each child `absolute inset-0`) so they overlap and the blur bridges the crossfade. Pair it with `active:scale-[0.97]` press feedback and `transition-colors` hover — the three compound into the "buttery button". Confirmed status colour stays a `kortix-*` token (`text-kortix-green`), never raw palette. **Reference:** `CopyButton` in `apps/web/src/components/markdown/unified-markdown.tsx`.

## Spacing cheat sheet (from reference views)

| Layer | Classes |
| --- | --- |
| Section wrapper → body | `space-y-5` |
| Search + content block | `space-y-4` |
| List of rows / disclosures | `space-y-2` inside `space-y-4` parent |
| Settings major sections | `space-y-8` |
| Tab panel content | `space-y-6` |
| Panel inner padding | `px-4 py-5` (standard), `px-4 py-3` (compact row) |
| Row internal gap | `gap-3` (row), `gap-1.5` (title/meta), `gap-2` (button groups) |
| Detail content below title | `mt-8` |
| No-match empty search | `px-3 py-6 text-center text-xs` |

**No direct padding on the outer bordered panel** — padding lives on inner content (`px-4 py-5`).

## Tokens — `globals.css` is law

### Color

Use only semantic tokens and `kortix-*` brand accents. **Never** raw Tailwind palette classes (`bg-blue-500`, `text-red-400`), raw hex/oklch, or manual `dark:` palette hacks.

**Brand accents (`kortix-*`):** `kortix-base`, `kortix-blue`, `kortix-yellow`, `kortix-orange`, `kortix-green`, `kortix-purple`, `kortix-red` — the *only* sources for semantic UI color.

| State | Token |
| --- | --- |
| success / running / connected | `kortix-green` |
| error / failed | `kortix-red` |
| warning / needs attention | `kortix-orange` |
| pending / informational | `kortix-yellow` |
| idle / neutral | `muted-foreground` |

**Active / selected:** `bg-primary/[0.05]`–`bg-primary/[0.08]` or `variant="subtle"` — never `bg-muted` for selection.

### Radius

| Surface | Radius |
| --- | --- |
| Panels, rows, tables | `rounded-md` |
| Flush seam inside disclosure | `rounded-none` on trigger button |
| Status icon tiles | `rounded-sm` (`size-8` or `size-9`) |
| Inputs / selects | `rounded-lg` via `variant="popover"` |
| Pills (buttons, badges) | `rounded-full` |

**Never:** `rounded-xl` / `rounded-2xl` on app containers, nested rounding (parent + child both rounded).

### Typography

- Section page title (wrapper): `text-xl font-medium`
- Panel section label: `Label` component
- Row title: `text-sm font-medium`
- Row meta: `text-xs text-muted-foreground`
- Detail title: `text-2xl font-semibold tracking-tight`
- Named sizes only — no `text-[11px]` except where `Badge size="xs"` already defines it

## Status pattern — tinted icon tile

```tsx
<span className={cn(
  'flex size-9 items-center justify-center rounded-sm',
  merged && 'bg-kortix-green/15',
  failed && 'bg-kortix-red/15',
  open && 'bg-kortix-blue/15',
)}>
  <Icon className={cn('size-5', merged && 'text-kortix-green', …)} />
</span>
```

Use **solid** icons at `size-5` inside `size-8`/`size-9` tiles. Pair with `Badge` for text labels when needed (`changes-view.tsx`, `sandbox-view.tsx`).

## Modal pattern (canonical — use `modal.tsx`)

From `secrets-view.tsx` / `channels-view.tsx` — **not** raw Dialog:

```tsx
<Modal open={open} onOpenChange={setOpen}>
  <ModalContent className="lg:max-w-lg">
    <ModalHeader>
      <ModalTitle>Title</ModalTitle>
      <ModalDescription>Description</ModalDescription>
    </ModalHeader>
    <form onSubmit={handleSubmit}>
      <ModalBody className="max-h-[60vh] overflow-y-auto">
        {/* fields */}
      </ModalBody>
      <ModalFooter className="sm:justify-between">
        <Button type="button" variant="outline-ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? <Loading className="size-4 shrink-0" /> : null}
          Save
        </Button>
      </ModalFooter>
    </form>
  </ModalContent>
</Modal>
```

Destructive confirms → `ConfirmDialog`, not a red-styled `Modal` trigger.

## Tabs pattern

- **Primary section tabs:** `TabsList type="underline"` + `TabsTrigger className="w-fit flex-none"` (`members-view.tsx`, `changes-view.tsx`)
- **Filter / status tabs:** `TabsListCompact` + `TabsTriggerCompact` (`changes-view.tsx`, `secrets-view.tsx`)
- Tab badge count: `<Badge variant="secondary" size="sm">` inside trigger

## Loading pattern (canonical)

**Every in-flight spinner is `Loading` from `loading.tsx`.** The component ships its own rotate/dash animation — do not swap in `Loader2`, `Loader`, or any other spinning icon.

```tsx
import Loading from '@/components/ui/loading';

// Button pending (replaces action icon)
<Button disabled={pending}>
  {pending ? <Loading className="size-3.5 shrink-0" /> : <Plus className="size-3.5 shrink-0" />}
  Save
</Button>

// Section header action
<Button size="sm" variant="secondary" disabled={pending}>
  {pending ? <Loading className="size-4 shrink-0" /> : <Plus className="size-4" />}
  New
</Button>

// Inline / modal submit
{pending ? <Loading className="size-4 shrink-0" /> : null}
```

For page-level loading placeholders use **`Skeleton`** (shape-matched). Use **`Loading`** only for active async operations (submit, fetch-in-button, mutation pending).

## Search + loading + empty flow

Standard content block (`agents-view.tsx` pattern):

```tsx
<div className="space-y-4">
  <InputGroupSearch>…<InputGroupSearchInput variant="popover" />…</InputGroupSearch>
  {isLoading ? (
    <div className="space-y-1">{/* Skeleton h-7 rounded-md × 5 */}</div>
  ) : isError ? (
    <ErrorState size="sm" action={<Button variant="outline" size="sm">Retry</Button>} />
  ) : items.length === 0 ? (
    <EmptyState icon={…} size="sm" action={…} />
  ) : (
  /* list */
  )}
</div>
```

## Dos & Don'ts

- ✅ Section shell → `CustomizeSectionWrapper`. ❌ hand-rolled outer flex + header.
- ✅ Panels → `bg-popover rounded-md border` + inner `px-4 py-5`. ❌ `SectionCard`, ❌ padding on the border element itself.
- ✅ Lists → `<ul className="space-y-2">` + entity row classes. ❌ `List` / `ListRow`, ❌ `divide-y` Card lists.
- ✅ Expandable config → `Disclosure` + `Button variant="popover"`. ❌ custom accordion, ❌ nested `rounded-md` inside rounded parent.
- ✅ Modals → `Modal` from `modal.tsx`. ❌ `Dialog`/`DialogContent` in features.
- ✅ Destructive actions → `ConfirmDialog` (or the inline two-step Cancel/confirm swap, `channels-view.tsx`). ❌ firing a delete/revoke mutation directly from a `variant="destructive"` click.
- ✅ Tooltips → `Hint`. ❌ `Tooltip` primitives in features.
- ✅ Toasts → `@/components/ui/toast` helpers. ❌ `@/lib/toast`, raw sonner.
- ✅ Badges → `<Badge size="sm" variant="…">`. ❌ hand-rolled chip spans.
- ✅ Status → tinted icon tile + optional `Badge`. ❌ raw palette icon colors.
- ✅ Color → `kortix-*` + semantic tokens. ❌ `text-emerald-600`, `bg-amber-500`.
- ✅ Meta separators → `InlineMeta` or `text-muted-foreground/40` bullet (`&bull;`). ❌ inconsistent separators.
- ✅ Empty → `EmptyState`. ❌ centered `<p>` only.
- ✅ Alerts → `InfoBanner`. ❌ hand-rolled colored banners.
- ✅ Pending spinners → `Loading` from `loading.tsx`. ❌ `Loader2`, `Loader`, or any `animate-spin` icon.

## Workflow checklist

1. **Load [`make-interfaces-feel-better`](../../../apps/web/.agents/skills/make-interfaces-feel-better/SKILL.md)** — run its review checklist after composing UI.
2. **Read the closest reference view** from the table above. Copy structure, spacing, and primitives — don't invent a new layout dialect.
3. Skim `/design-system` and `src/components/ui/` for anything not covered by the reference.
4. Compose: `CustomizeSectionWrapper` → search/panel/row/disclosure/table → `Badge` + `Hint` + `Modal` + `toast` + `Loading` + `EmptyState`. **Never** `SectionCard`, `List`, or `Loader2`.
5. Status → tinted icon tile. Color → `kortix-*`. Radius → `rounded-md` (panel), `rounded-none` (flush trigger).
6. New primitive? Tokens only, tiny API, add to `/design-system`.
7. Verify: no banned imports, no raw palette colors, no nested rounding, light + dark, `tsc` clean, polish checklist from `make-interfaces-feel-better`.
