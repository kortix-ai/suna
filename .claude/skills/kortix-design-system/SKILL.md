---
name: kortix-design-system
description: "Use when building or editing any visual surface in apps/web — a page, screen, list, card, badge, avatar, modal, form, empty state, toast, tooltip, table, or panel — and you need to know WHICH component to compose and which primitives are banned. Load kortix-brand-guidelines first for the values (color, spacing, type, radius, motion budget); this file assumes those and covers components, layout shells, and reference implementations. Source of truth: src/components/ui, the live /design-system page, and the reference implementations listed inside."
---

# Kortix Design System

**Track this file:** `.claude/skills/kortix-design-system/SKILL.md`

**If you are touching a visual surface in `apps/web`, follow this.** This file owns **which component to compose**. It does not own values — see below.

> **Read [`kortix-brand-guidelines`](../kortix-brand-guidelines/SKILL.md) first.**
> It is the value law: the closed allowlist for every color, spacing step, type
> rung, radius, elevation, easing and duration, plus the rule on **whether to
> animate at all**. This file assumes you already know those values and shows
> you what to build with them.

## Companion skills — load all three

| Skill | Owns | Wins when they conflict |
| --- | --- | --- |
| [**kortix-brand-guidelines**](../kortix-brand-guidelines/SKILL.md) | The value allowlists. Color, spacing, type, radius, elevation, motion budget. Rejected defaults. `audit.sh`. | **Values and motion restraint** |
| **kortix-design-system** (this file) | Components, layout shells, reference implementations, banned primitives | **Which component** |
| [**make-interfaces-feel-better**](../../../apps/web/.agents/skills/make-interfaces-feel-better/SKILL.md) | Polish: concentric radius, optical alignment, tabular nums, hit areas, font smoothing | **Polish detail** |

A polish skill will always propose more motion than Kortix wants.
`kortix-brand-guidelines` is the ceiling all three operate under.

## Errata — corrections to earlier versions of this file

- **The elevation ladder described here through Aug 2026 does not exist.** An
  earlier revision claimed `@theme` in `globals.css` defines four-sided soft
  shadows and that `shadow-*` renders them. Verified false at HEAD:
  `grep -an "shadow-" apps/web/src/app/globals.css` returns exactly one line,
  `--shadow-liquid-glass`. `shadow-*` is **stock Tailwind**. The *semantics*
  below (which step for which surface) still hold; the custom rendering does not.
- **The house press value is `active:scale-[0.96]`** (169 uses), not `0.97`
  (21 uses).

## Philosophy

- **Simplicity is the brand.** Black & white + one accent. Calm, spacious, legible. No decoration that doesn't carry information. Show only important data.
- **Reuse > Compose > Create.** In that order. Never hand-roll something the system already provides.
- **Tokens are law.** `apps/web/src/app/globals.css` is the implementation source of truth for every visual property. If a value conflicts with anything else, `globals.css` wins.
- **Fast, or none.** Kortix is a speed product. Motion exists to make the UI feel *faster* and to say where a thing came from — never to be admired. The more you animate, the less each animation is worth. The default answer to "should this animate?" is **no**.
- **AI-native & self-documenting.** The living styleguide at `/design-system` renders every component. When you add a component, add it there too.

## Strictly avoid — deprecated primitives

**Do not use these in new work or when refactoring screens.** They are legacy wrappers; match the hand-composed patterns in the customize section views instead.

| Banned | Use instead |
| --- | --- |
| **`SectionCard`** (`apps/web/src/components/ui/section-card.tsx`) | `Card` (`card.tsx`), `Label` + `bg-popover rounded-md border` panel, or `Disclosure` — see `project-settings-page.tsx` |
| **`List` / `ListRow`** (`apps/web/src/components/ui/list.tsx`) | `<ul className="space-y-2">` + entity row classes — see `changes-view.tsx`, `access-row.tsx` |
| **`Dialog` / `DialogContent`** in feature code | **`Modal`** from `apps/web/src/components/ui/modal.tsx` — see `secrets-view.tsx`, `channels-view.tsx` |
| **`Tooltip` / `TooltipTrigger` / `TooltipContent`** in feature code | **`Hint`** from `apps/web/src/components/ui/hint.tsx` |
| **`@/lib/toast`**, raw `sonner`, `toast.custom()` | Named helpers from `apps/web/src/components/ui/toast.tsx` |
| Hand-rolled badge `<span>` chips | **`Badge`** from `apps/web/src/components/ui/badge.tsx` |
| **Any icon as a spinner** — `CircleNotchIcon`, `SpinnerIcon`, `SpinnerGapIcon`, or the same glyph aliased to `Loader`/`Loader2`/`IconLoader` | **`Loading`** from `apps/web/src/components/ui/loading.tsx` — the codebase's only spinner |
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
| Confirm destructive | `apps/web/src/components/ui/confirm-dialog.tsx` | **Mandatory before any destructive mutation** — including `DropdownMenuItem variant="destructive"` items (see `secrets-view.tsx` delete, `sections/view/gateway/gateway-keys.tsx` revoke). Only accepted alternative: the inline Cancel/confirm button swap used for channel disconnects (`channels-view.tsx`). Never mutate from a single click |
| Loading / pending spinners | `apps/web/src/components/ui/loading.tsx` | `import Loading from '@/components/ui/loading'` — default `size-4`; use `className="size-4 shrink-0"` in dense buttons. **Never** `CircleNotchIcon`, `SpinnerIcon`, or other icons |

Also reach for: `Button`, `ButtonGroup`, `Input`, `Select`, `Switch`, `Skeleton`, `Tabs` / `TabsListCompact`, `Table`, `InlineMeta`, `UserAvatar`, `EntityAvatar`.

## Reference implementations — customize section views

**Read the closest match before building any new screen.** Paths below are
relative to `apps/web/src/features/workspace/` unless given in full.

| File | Pattern to copy |
| --- | --- |
| **`customize/sections/component/section-wrapper.tsx`** | Section shell: title left, action right, `max-w-2xl`, responsive header |
| **`capabilities/agents/agents-page.tsx`** | Config entity list: search → rows → detail aside with `Badge`, `ButtonGroup` + `Hint`, toasts |
| **`customize/sections/view/skills-view.tsx`** | Disclosure config-entity flow; `EmptyState` + docs link; `InfoBanner` for 403 |
| **`capabilities/project-settings/project-settings-page.tsx`** | Form sections: `Label` header → `bg-popover rounded-md border px-4 py-5` panel; `Disclosure` for experimental; danger zone as neutral bordered row |
| **`customize/sections/view/secrets-view.tsx`** | `Table` + `TabsListCompact` filters + **`Modal`** forms + `DropdownMenu` row actions |
| **`shared/access/access-row.tsx`** | Entity rows, `UserAvatar`, `InlineMeta` — the single row used by every access surface |
| **`customize/sections/view/changes-view.tsx`** | Tinted `size-9` icon tiles, `Badge variant="kortix" size="xs"`, row inline actions, `TabsListCompact` |
| **`customize/sections/view/channels-view.tsx`** | `Table` for integrations, `Modal` for connect flows, `InfoBanner` for connected state |
| **`customize/sections/view/dev-view.tsx`** | `Stepper` onboarding, command blocks, minimal bordered panels |
| **`apps/web/src/features/tunnel/tunnel-overview.tsx`** | Device/computer list; the former `computers-view` delegated to it |

**Shells:** `capabilities/index/customize-index-page.tsx` (the customize index)
and `capabilities/shared/capability-page-shell.tsx` (`CapabilityPageShell`) — the
current shell for capability pages. The older `CustomizeSectionWrapper`
(`customize/sections/component/section-wrapper.tsx`) still backs the
`customize/sections/view/*` screens.

**Other references:** tinted-icon tiles → `apps/web/src/components/projects/schedule-view.tsx`; sidebar → `project-sidebar/project-sidebar.tsx`.

## Layout & responsiveness

**Always wrap a section in the shell its tree already uses** — `CapabilityPageShell`
under `capabilities/`, `CustomizeSectionWrapper` under `customize/sections/view/`.
Do not hand-roll the outer shell.

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

Every panel is a `bg-popover rounded-md border` surface. Two sanctioned ways to build one — never `SectionCard`:

- **`Card`** (`apps/web/src/components/ui/card.tsx`) — the codified panel. Use it when the surface has a title/description/action header, distinct content, or a footer. Slots carry the spacing (`px-4`, `pt-5`/`pb-5`, `gap-5` between slots — the panel `px-4 py-5` rhythm); the bordered element itself has **no padding**, so flush children (tables, lists, images) sit edge-to-edge.
- **Hand-composed `div`** — for a one-off padded block inside a section, the one-div shorthand `bg-popover rounded-md border px-4 py-5` is fine (the `project-settings-page.tsx` pattern). The moment the panel needs a flush child or an internal seam, move the padding onto inner sections.

Panels are **flat**: border, no shadow — elevation is for overlays (see *Elevation* under Tokens).

### Card (component)

```tsx
<Card>
  <CardHeader>
    <CardTitle>Repository</CardTitle>
    <CardDescription>Where builds are pushed.</CardDescription>
    <CardAction>
      <Button size="sm" variant="secondary">Edit</Button>
    </CardAction>
  </CardHeader>
  <CardContent>{/* fields, rows — or a flush table as a direct Card child */}</CardContent>
  <CardFooter className="border-t">{/* meta or trailing actions */}</CardFooter>
</Card>
```

- `CardTitle` is `text-sm font-medium` — panel-label scale, same as `Label`. Don't scale it up; a Card is a panel, not a hero.
- Divided header: `<CardHeader className="border-b">` (it compacts to `pb-4`); divided footer: `className="border-t"`.
- `variant="glass"` (`bg-card/40 border-border/40 shadow-sm`) is the only elevated variant — translucent surfaces over wallpaper/media.

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

Access rows use `py-2.5` (`shared/access/access-row.tsx`). Changes use `py-2`.

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
| Section header primary action | `Button size="sm" variant="secondary"` + `PlusIcon` (`size-4`) + label; group with `gap-1.5` |
| Empty state CTA | `Button variant="outline" size="sm" className="gap-1.5"` |
| Docs / secondary link | `Button asChild variant="ghost" size="sm" className="gap-1.5"` |
| Row secondary action | `Button variant="ghost" size="sm"` |
| Row primary action | `Button size="sm"` (default variant) |
| Icon-only with tooltip | `Hint` → `Button variant="outline" size="icon"` inside `ButtonGroup` |
| Inline text link | `Button variant="transparent" size="sm" asChild` |
| Modal cancel | `Button variant="outline-ghost"` |
| Pending / in-flight state | `<Loading className="size-4 shrink-0" />` in buttons; `<Loading />` or `className="size-4 shrink-0"` in headers — **never** `CircleNotchIcon` |

Icons in buttons: `size-3.5 shrink-0` (dense) or `size-4` (header). Always `shrink-0` on icons. **Exception:** loading uses `Loading`, not an icon import.

## Icons — Phosphor only

**The only icon library in apps/web is `@phosphor-icons/react`.** `lucide-react`,
`react-icons`, `@mynaui/icons-react`, and `@icons-pack/react-simple-icons` are
removed and blocked by ESLint (`no-restricted-imports`).

- Always import the `*Icon`-suffixed exports: `PlusIcon`, `MagnifyingGlassIcon`,
  `CaretRightIcon` — never the deprecated bare names (`Plus`).
- **Never pass a `weight` prop.** One constant governs the whole app:
  `DEFAULT_ICON_WEIGHT` in `src/lib/icons/icon-config.ts` (currently `bold`).
  Change it, save, and every icon flips; commit it and production renders the
  same. There is no runtime toggle and **no dev/prod branching** — the constant
  is the single source of truth in every environment. Compare all six weights
  at /design-system → Icons.
- **Two delivery paths, same constant, both propless:**
  - *Client components* → `IconProvider` (root layout) feeds it to Phosphor's
    `IconContext`. Import from `@phosphor-icons/react`.
  - *Server components (RSC)* → React context does not exist in RSC, so import
    from **`@/lib/icons/ssr`**, where the weight is pre-bound. Importing
    `@phosphor-icons/react/dist/ssr` directly is ESLint-blocked (it silently
    defaults to `regular`); importing the main entry in a server component
    crashes the build (`createContext` at module scope). Adding an icon to a
    server component? Add its two lines to `src/lib/icons/ssr.tsx`.
- **Exception — solid intent:** status tiles, success checks, destructive
  trash, and logo glyphs pass an explicit `weight="fill"` so they stay solid
  regardless of the global weight. This is the only weight prop in the codebase.
- Semantic layer: `src/components/ui/kortix-icons.ts` (`IconAdd`, `IconDelete`,
  …) re-exports Phosphor icons; prefer it where already adopted. It re-exports
  the client entry, so it is client-graph only.
- Sizing stays Tailwind-first (`size-4`, `size-3.5 shrink-0` in dense buttons);
  the provider's `size: 24` default only covers class-less usages.
- Background on the RSC rule above: the main entry calls `createContext` at
  module scope with no `'use client'` directive, so a server-only module graph
  reaching it crashes the build with
  `TypeError: (0, d.createContext) is not a function`. Phosphor's own SSR entry
  fixes the crash but hardcodes `weight="regular"`, which would quietly ignore
  `DEFAULT_ICON_WEIGHT` — that is why `@/lib/icons/ssr` exists and why the raw
  entry is ESLint-blocked outside it.

## Motion in components

**Budget and easings live in [`kortix-brand-guidelines` → Motion](../kortix-brand-guidelines/SKILL.md).**
Read the frequency ladder there before adding any animation. The short version:

> Kortix is a speed product. **Fast, or none.** Count how many times a day a user
> sees the interaction; that number sets the budget. Constant-use surfaces —
> keyboard nav, dense-list hover, focus moves, table selection — get
> **no animation at all**.

What that means for the components in this file:

| Component | Motion |
| --- | --- |
| Row hover in a list, sidebar nav | `transition-colors duration-fast`. Color only — never position. |
| Keyboard-driven selection / arrow-key nav | **None.** `transition-none`. |
| `Disclosure`, `Tabs` | 200ms, `ease-out`. Built in — do not add more. |
| `Modal`, `Dialog`, sheets | 300ms max, `ease-out`, enter from `scale-0.97`. Built into `modal.tsx`. |
| Toast | Owned by `toast.tsx`. Do not restyle its motion. |
| `Loading` | Ships its own rotation. Never add `animate-spin`. |
| Buttons | `active:scale-[0.96]` + `transition-colors`. Nothing else. |
| Skeleton → content | Cross-fade opacity, or nothing. Never a stagger. |

**Do not add enter animations to list items.** A staggered or animated list is
measurably slower to read and to click than the same list appearing at once, and
the cost is paid on every render.

### Sanctioned exception — the icon-swap morph

**Frequency gate:** this pattern is for buttons whose state change is *meaningful
and occasional* — copy → copied, connect → connected, follow → following. It is
**not** for a control the user hits repeatedly in a working session. If in doubt,
hard-swap the icon; a hard swap is never wrong, it is only plain.

When it does apply: never hard-swap `{done ? <CheckIcon/> : <CopyIcon/>}` with no
transition. Cross-fade the two icons in the same box with **blur + scale +
opacity** so it reads as one morph, not two objects blinking. The blur is what
bridges the two states — without it the eye sees two distinct objects.

Values: **scale `0.25 → 1`, opacity `0 → 1`, blur `4px → 0`**, spring
**`{ type: 'spring', duration: 0.3, bounce: 0 }`**. `bounce: 0` is the brand.
Always `initial={false}` so nothing animates on first paint.

```tsx
import { AnimatePresence, motion } from 'motion/react';

<button
  onClick={handleCopy}
  aria-label={copied ? 'Copied' : 'Copy'}
  className={cn(
    'inline-flex size-7 items-center justify-center rounded-md',
    'text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10',
    'cursor-pointer transition-colors active:scale-[0.96]',
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
        {copied ? <CheckIcon className="size-3.5 text-kortix-green" /> : <CopyIcon className="size-3.5" />}
      </motion.span>
    </AnimatePresence>
  </span>
</button>
```

Rules: both icons share one fixed-size box (`relative size-3.5` parent, each
child `absolute inset-0`) so they overlap and the blur bridges the crossfade.
Confirmed status colour stays a `kortix-*` token (`text-kortix-green`), never raw
palette. Ship a `prefers-reduced-motion` branch — drop the scale and blur, keep
the opacity. **Reference:** `CopyButton` in
`apps/web/src/components/markdown/copy-button.tsx`.
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
| `Card` slot rhythm | `px-4` all slots; `pt-5` header / `pb-5` last slot; `gap-5` between slots |

**Padding never sits on a bordered element that hosts flush children** (tables, lists, seams) — put it on the slots/inner sections. A single padded block may use the one-div shorthand `bg-popover rounded-md border px-4 py-5`.

## Tokens — see `kortix-brand-guidelines`

**Every value lives in [`kortix-brand-guidelines`](../kortix-brand-guidelines/SKILL.md).**
Colors, spacing steps, type rungs, radius ladder, elevation steps, easings and
durations are enumerated there as closed allowlists, with the reasons and the
`audit.sh` that enforces them. This file used to restate them; two copies drift,
so the copy is gone.

The five facts you will get wrong from stock Tailwind habit, restated here only
because they bite immediately:

| Fact | Consequence |
| --- | --- |
| `--spacing: 0.23rem`, not `0.25rem` | Every spacing utility is 8% tighter. A 16px mockup padding is `p-4`, never `p-[16px]`. |
| `--text-xs: 0.8125rem` = **13px**, not 12px | `text-xs` is the workhorse (1999 uses). There is no rung below it. |
| `--radius: 0.625rem` → `rounded-md` is **8px** | `rounded-md` is the default for every panel, row, table and card. |
| Color is semantic tokens + the seven `kortix-*` accents | No raw palette, no hex, and **no `dark:` for color** — tokens flip themselves. |
| In-flow surfaces are **flat** — border, no shadow | Shadows mean "floats above the page". |
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

Use `weight="fill"` icons at `size-5` inside `size-8`/`size-9` tiles. Pair with `Badge` for text labels when needed (`changes-view.tsx`, `sandbox-provider-coverage.tsx`).

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

- **Primary section tabs:** `TabsList type="underline"` + `TabsTrigger className="w-fit flex-none"` (`changes-view.tsx`, `channels-view.tsx`)
- **Filter / status tabs:** `TabsListCompact` + `TabsTriggerCompact` (`changes-view.tsx`, `secrets-view.tsx`)
- Tab badge count: `<Badge variant="secondary" size="sm">` inside trigger

## Loading pattern (canonical)

**Every in-flight spinner is `Loading` from `loading.tsx`. There are no exceptions and no second spinner in this codebase.** The component ships its own rotate/dash animation, so it never needs `animate-spin`.

**No icon is ever a spinner.** Not `CircleNotchIcon`, not `SpinnerIcon`, not `SpinnerGapIcon`, not any other Phosphor glyph, whatever it is aliased to (`Loader`, `Loader2`, `IconLoader`, …). If you catch yourself writing `animate-spin` on an icon, the answer is `Loading`. `kortix-icons.ts` deliberately exports **no** loader icon so the semantic layer can't offer you one.

```tsx
import Loading from '@/components/ui/loading';

// Button pending (replaces action icon)
<Button disabled={pending}>
  {pending ? <Loading className="size-3.5 shrink-0" /> : <PlusIcon className="size-3.5 shrink-0" />}
  Save
</Button>

// Section header action
<Button size="sm" variant="secondary" disabled={pending}>
  {pending ? <Loading className="size-4 shrink-0" /> : <PlusIcon className="size-4" />}
  New
</Button>

// Inline / modal submit
{pending ? <Loading className="size-4 shrink-0" /> : null}
```

For page-level loading placeholders use **`Skeleton`** (shape-matched). Use **`Loading`** only for active async operations (submit, fetch-in-button, mutation pending).

## Search + loading + empty flow

Standard content block (`agents-page.tsx` pattern):

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
- ✅ Panels → `Card` (`card.tsx`) or `bg-popover rounded-md border` with `px-4 py-5`. ❌ `SectionCard`, ❌ padding on a bordered element that hosts flush children.
- ✅ Elevation → ladder step (`shadow-md` popovers, `shadow-lg` modals); in-flow panels stay flat with a border. ❌ `dark:shadow-*`, ❌ `shadow-[…]` when a step fits.
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
- ✅ Pending spinners → `Loading` from `loading.tsx`. ❌ `CircleNotchIcon`, `SpinnerIcon`, or any `animate-spin` icon.
- ✅ Motion → count the frequency first; `transition-colors duration-fast` on hover, `ease-out` on enter/exit, `active:scale-[0.96]` on press. ❌ `transition-all`, ❌ bare `transition`, ❌ `ease-in`, ❌ anything over 300ms in product UI.
- ✅ Keyboard-driven interactions → `transition-none`. ❌ animating arrow-key nav or focus moves.
- ✅ Every animation ships a `prefers-reduced-motion` variant. ❌ one variant only.
- ✅ List items appear at once. ❌ stagger in product UI.

## Workflow checklist

1. **Load [`kortix-brand-guidelines`](../kortix-brand-guidelines/SKILL.md)** — the value allowlists and the motion budget. Then this file, then [`make-interfaces-feel-better`](../../../apps/web/.agents/skills/make-interfaces-feel-better/SKILL.md).
2. **Read the closest reference view** from the table above. Copy structure, spacing, and primitives — don't invent a new layout dialect.
3. Skim `/design-system` and `src/components/ui/` for anything not covered by the reference.
4. Compose: `CustomizeSectionWrapper` → search/panel/row/disclosure/table → `Badge` + `Hint` + `Modal` + `toast` + `Loading` + `EmptyState`. **Never** `SectionCard`, `List`, or `CircleNotchIcon`.
5. Status → tinted icon tile. Color → `kortix-*`. Radius → `rounded-md` (panel), `rounded-none` (flush trigger). Elevation → overlays only; flat border for in-flow panels.
6. **Motion last.** Count how often a user sees it. Constant → none. Otherwise ≤300ms, `ease-out`, named property, token duration, reduced-motion variant.
7. New primitive? Tokens only, tiny API, add to `/design-system`.
8. Verify: `.claude/skills/kortix-brand-guidelines/audit.sh <your paths>` clean, no banned imports, no nested rounding, light + dark, `tsc` clean, polish checklist from `make-interfaces-feel-better`.
9. Replay the interaction ten times. If you still notice the animation, it is too much.
