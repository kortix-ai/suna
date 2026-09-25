---
name: kortix-presentation
description: Build, edit, present, and record Kortix decks. A Kortix presentation is a Next.js route under /presentations in apps/web — never a file. Load WHENEVER the user asks for a deck, slides, a presentation, a walkthrough, a talk track, a guided demo, presenter notes, or wants to record a product video; and whenever editing anything under apps/web/src/app/presentations.
---

# Kortix Presentations

**A Kortix deck is a Next.js route.** Every presentation lives at
`/presentations/<slug>` in `apps/web`, styled like the marketing site, driven by
the keyboard, and built to be screen recorded.

There is no file format. Do not produce `.pptx`, Keynote, Google Slides, or a
Markdown "slides" file — that output gets rejected on sight, and nothing in this
skill will help you make one. A deck is a React component: it themes correctly,
stays sharp at any projection size, is reviewed in a PR, and cannot drift from
the product copy because it imports the same content modules the marketing pages
do.

## Where everything is

```
apps/web/src/app/presentations/
  layout.tsx        full-bleed shell, noindex
  page.tsx          the index — every deck, one card each
  index-client.tsx  the index UI (client: reads each deck's slides for counts)
  registry.ts       the ONE file you edit to add a deck
  [deck]/
    page.tsx        server route: generateStaticParams + generateMetadata
    deck-client.tsx resolves slug → deck, mounts the engine
  decks/<slug>.tsx  a deck: `useSlides(): SlideDef[]`
  engine/
    deck.tsx        keyboard engine, build steps, presenter notes, overview
    parts.tsx       Slide, SectionHead, Spine, Panel, RowList, Shot, Rise…
    diagram.tsx     build-aware mechanism diagrams
  README.md         the authoring guide this skill summarises
```

Shipped decks: `security` (diagram-led — **the reference implementation, read it
first**), `platform`, `sales`. Legacy `/presentation` paths 307 to their new
homes via `next.config.ts`. The tree is allowlisted public in `src/middleware.ts`
— decks are link-shared and `noindex`, never behind a login.

## Using a deck

Open `/presentations`, pick one, press `F`.

| Key | Does |
| --- | --- |
| `→` `Space` `J` | next build step, or next slide |
| `←` `K` | back one step, or previous slide fully built |
| `Home` `End` | first / last slide |
| `1`–`9` | jump to slide |
| `G` `Esc` | overview grid (every slide, fully built) |
| `F` | fullscreen |
| `N` | presenter notes — the spoken script |

**Recording:** open the deck, press `F`, record the tab. Read the script first
with `N` → **Full script**, then close the drawer — notes never render on the
stage, so the recording stays clean. Prefer light theme on decks that embed
product screenshots, since the screenshots are light. Reload before you record:
after a hot reload in dev, accumulated keydown listeners make one press jump
several steps.

## Adding a deck — two edits

**1. `decks/<slug>.tsx`** — a client component exporting `useSlides()`:

```tsx
'use client';

import type { SlideDef } from '../engine/deck';
import { Slide, Rise, Spine, Panel, Dim } from '../engine/parts';

export function useSlides(): SlideDef[] {
  return [
    {
      id: 'title',
      label: 'Chapter name',
      notes: 'What you say while this is on screen.',
      node: (
        <Slide>
          <Rise i={0}>
            <h1 className="text-foreground text-5xl font-medium tracking-tight">
              The claim
            </h1>
          </Rise>
        </Slide>
      ),
    },
  ];
}
```

**2. A row in `DECKS` in `registry.ts`:**

```ts
{
  slug: 'connectors',
  title: 'Connectors walkthrough',
  description: 'One line for the index card and the route metadata.',
  kind: 'Product',
  tags: ['Diagram-led'],
  useSlides: useConnectorsSlides,
}
```

There is no step 3. The route, the index card, the slide and build counts, the
length estimate and the page metadata are all derived from those two edits.

## The slide API

```tsx
type SlideDef = {
  id: string;          // stable, unique within the deck
  label: string;       // shown bottom-left on the stage
  node: ReactNode | ((step: number) => ReactNode);
  steps?: number;      // extra build steps. Total → presses = steps + 1
  notes?: string | readonly string[];  // the spoken script
};
```

## Builds — the format Kortix decks use

`steps: 3` means `→` is pressed four times on that slide, and `node(step)` lights
up one more part of the picture each time. Advancing past the last step moves on;
reversing off step 0 lands on the previous slide at *its* last step, so `←`
always undoes exactly what `→` just did.

This is the point of the format: **a diagram assembles while it is explained,
instead of landing all at once.** Reach for it whenever you are explaining a
mechanism — a request crossing a boundary, a branch becoming a merge, a call
being held and released.

**The hard rule: never mount or unmount on a build step.** Every element is in
the DOM from the first frame, ghosted, and a step raises its opacity. If parts
appeared instead, every press would reflow the slide and the viewer would lose
the thread.

```tsx
// ✅ opacity — layout is stable, the eye tracks what changed
<div className={cn('transition-opacity duration-500', step >= 1 ? 'opacity-100' : 'opacity-15')}>

// ❌ conditional render — the slide jumps on every press
{step >= 1 ? <Panel /> : null}
```

`engine/diagram.tsx` does this for you via its internal `Reveal`. The one
deliberate exception is a travelling packet (`Link fire`), which is genuinely
transient and mounts for its step only.

## Presenter notes

`notes` is what you *say*, not what is on screen. Pass an array to give each
build step its own line; the drawer follows the step you are on. Write spoken
sentences — contractions are fine, numerals read aloud ("SOC 2 Type One"), no
bullet fragments.

## Diagrams

`engine/diagram.tsx` provides `Stage` (framed card with a caption rail), `Box`,
`Chip`, `Link` (rail + arrowhead + optional travelling packet), `Wall`, `Row`.
Shipped machines: `IsolationDiagram`, `BrokerDiagram`, `ChangeRequestDiagram`,
`PrincipalDiagram`, `LedgerDiagram`.

- The **caption** carries the sentence that changes per step. The slide title
  should not move.
- Connector rails never fully fade — the wiring of a system stays readable even
  where traffic is not flowing yet. Only ghosted nodes drop to `0.12`.
- Color is monochrome plus `kortix-*` tokens for verdicts only: green = allowed
  or merged, orange = held, red = blocked or refused. Never raw Tailwind palette.
- Declare sub-components at **module scope**, never inside a diagram's render —
  a component created during render is a new type every step, so React remounts
  it and the animation restarts instead of continuing. `react-hooks/static-components`
  catches this.

## Structure discipline — the rule that matters most

**Say how many parts there are, then have exactly that many.** The security deck
promised "four answers" and originally ran seven chapters; rebuilding it to four,
with a `Spine` on every chapter slide, did more for it than any visual work.

- Name the chapters in a `const` at the top of the deck file and render them
  through `<Spine chapters={CHAPTERS} active={n} />`.
- One diagram per chapter, one supporting slide at most.
- A fifth idea belongs on the marketing page, not the deck. State the rule in the
  deck's file header so the next edit does not quietly grow one.
- Chapter slides get a title and the machine — **no lead paragraph.** On a build
  slide a second block of prose competes with the narration.
- Roughly 20 seconds of narration per build step. 25–30 builds is a comfortable
  eight-to-ten-minute video.

## Copy accuracy — non-negotiable

Import copy from the marketing content modules
(`apps/web/src/features/marketing/*/content.ts`), never retype it. Those files
carry accuracy gates in their headers: the claims verified against shipped code,
and the corrections that must not be "restored". A deck that retypes a claim is a
deck still saying it a year after the product stopped doing it.

Standing traps, all of which a security reviewer will test:

- **Never** blanket "microVM" — true for Platinum (Cloud Hypervisor) only, not
  the default provider. Say "sandbox" / "cloud computer". Never "container".
- **Never** "secrets scoped to a person or a group" — that model was retired.
  Scoping is per project, per agent grant, and connector-scoped.
- **Never** "the key never sits in the sandbox" as a blanket claim. True of
  connector credentials; false of a granted runtime secret, which is a real
  environment value in the session. Say the narrow version.
- **Never** "only a human can merge" — merge is default-deny for agents and needs
  an explicit `project.cr.merge` grant. That is the stronger claim anyway.
- **Never** claim a certification. SOC 2 is *in progress*; there is no ISO or
  HIPAA. **Never** name a licence — "open source" and stop.

Read [`../comms/SKILL.md`](../comms/SKILL.md) for voice and banned phrases, and
[`../brand-guidelines/SKILL.md`](../brand-guidelines/SKILL.md) for visual
identity, before writing on-slide text.

## Visual language

Compose from `engine/parts.tsx` before inventing chrome. The vocabulary mirrors
the marketing homepage: mono-uppercase eyebrows, `text-3xl/4xl font-medium
tracking-tight` titles, `rounded-sm` thin-border panels on `bg-card`,
`KortixAsterisk` bullets, real product screenshots in `Shot`.

Theme-following always — semantic tokens (`text-foreground`, `bg-card`,
`border-border`) and `kortix-*` accents, never a forced palette and never a
`dark:` hack.

A slide is one viewport and must never scroll. Cap screenshots in `vh`:

```tsx
<Shot src="/media/…" alt="…" imgClassName="max-h-[48vh] object-cover object-top" />
```

`object-top` keeps the top of the screen, where the product is, and crops the
empty bottom rather than letterboxing it.

## QA before delivery — do not skip

```bash
cd apps/web
npx tsc --noEmit                    # must be clean in src/app/presentations
npx eslint src/app/presentations    # 0 errors
```

`tsc --noEmit` reports ~15 pre-existing `@types/bun` `test.each` errors elsewhere
in the app — those are the documented baseline, not yours. Nothing under
`presentations` may appear.

Then drive it in the browser (chrome-devtools MCP):

1. Every slide renders — press `G` for the overview, which shows all slides
   **fully built**, and check it in one screenshot.
2. Step at least one build slide by hand; confirm each press adds exactly one
   stage and the layout does not jump.
3. Both themes. A light screenshot inside a dark deck reads as a bright panel —
   look at it, don't assume.
4. Console clean.

Reload the page before each check: after a hot reload, one press can jump several
steps. That is a dev artifact of accumulated listeners, not a bug in the engine.
