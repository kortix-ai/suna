---
name: kortix-presentation
description: Build, edit, present, and record Kortix decks. Kortix presentations are CODE — routes under /presentations in apps/web, never .pptx or Keynote files. Load WHENEVER the user asks for a deck, slides, a presentation, a walkthrough, a talk track, a guided demo, presenter notes, or wants to record a product video; and whenever editing anything under apps/web/src/app/presentations.
---

# Kortix Presentations

**A Kortix deck is a route, not a file.** Every presentation lives at
`/presentations/<slug>` in `apps/web`, styled like the marketing site, driven by
the keyboard, and built to be screen recorded.

Do not produce a `.pptx`, a Keynote, a Google Slides link, or a Markdown
"slides" file. That output has been rejected on sight. A deck is a component: it
themes correctly, stays sharp at any projection size, is reviewed in a PR, and
cannot drift from the product copy because it imports the same content modules
the marketing pages do. (The one narrow exception is at the bottom of this file.)

## Where everything is

```
apps/web/src/app/presentations/
  page.tsx          the index — every deck, one card each
  registry.ts       the ONE file you edit to add a deck
  [deck]/           the route: /presentations/<slug>
  decks/<slug>.tsx  a deck: `useSlides(): SlideDef[]`
  engine/
    deck.tsx        keyboard engine, build steps, presenter notes, overview
    parts.tsx       Slide, SectionHead, Spine, Panel, RowList, Shot, Rise…
    diagram.tsx     build-aware mechanism diagrams
  README.md         the authoring guide this skill summarises
```

Existing decks: `security` (diagram-led, the reference implementation),
`platform`, `sales`. The legacy `/presentation` paths 307 to their new homes.

## Using a deck

Open `/presentations`, pick a deck, press `F`.

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
product screenshots, since the screenshots are light. Reload before recording:
after a hot reload in dev, one arrow press can jump several steps.

## Adding a deck — two edits

1. Write `decks/<slug>.tsx` exporting `useSlides(): SlideDef[]`.
2. Add a row to `DECKS` in `registry.ts`.

There is no step 3. The route, the index card, the slide and build counts, the
length estimate and the page metadata are all derived.

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

`steps: 3` means → is pressed four times on that slide, and `node(step)` lights
up one more part of the picture each time. Advancing past the last step moves
on; reversing off step 0 lands on the previous slide at *its* last step, so ←
always undoes exactly what → just did.

This is the point of the format: **a diagram assembles while it is explained,
instead of landing all at once.** Reach for it whenever you are explaining a
mechanism — a request crossing a boundary, a branch becoming a merge, a call
being held and released.

**The hard rule: never mount or unmount on a build step.** Every element is in
the DOM from the first frame, ghosted, and a step raises its opacity. If parts
appeared instead, every press would reflow the slide and the viewer would lose
the thread. `engine/diagram.tsx` does this for you via its `Reveal`; if you
hand-roll, use opacity transitions, never conditional rendering.

The one deliberate exception is a travelling packet (`Link fire`), which is
genuinely transient and mounts for its step only.

## Presenter notes

`notes` is what you *say*, not what is on screen. Pass an array to give each
build step its own line; the drawer follows the step you are on. Write them as
spoken sentences — contractions are fine, numerals read aloud ("SOC 2 Type One"),
no bullet fragments.

## Diagrams

`engine/diagram.tsx` provides `Stage` (the framed card with a caption rail),
`Box`, `Chip`, `Link` (rail + arrowhead + optional travelling packet), `Wall`,
and `Row`. Shipped machines: `IsolationDiagram`, `BrokerDiagram`,
`ChangeRequestDiagram`, `PrincipalDiagram`, `LedgerDiagram`.

- The **caption** carries the sentence that changes per step. The slide title
  should not move.
- Connector rails never fully fade — the wiring of a system stays readable even
  where traffic is not flowing yet. Only `GHOST` parts drop to 0.12.
- Color is monochrome plus `kortix-*` tokens for verdicts only: green = allowed
  or merged, orange = held, red = blocked or refused. Never raw Tailwind palette.

## Structure discipline — the rule that matters most

**Say how many parts there are, then have exactly that many.** The security deck
promised "four answers" and originally ran seven chapters; it was rebuilt to
four, with a `Spine` on every chapter slide showing which one you are in. That
single change did more for it than any visual work.

- Name the chapters in a `const` at the top of the deck file, and render them
  through `<Spine chapters={…} active={n} />`.
- One diagram per chapter, one supporting slide at most.
- A fifth idea belongs on the marketing page, not in the deck. State the rule in
  the deck's file header so the next edit does not quietly grow one.
- Chapter slides get a title and the machine — no lead paragraph. On a build
  slide a second block of prose just competes with the narration.
- Aim for roughly 20 seconds of narration per build step. 25–30 builds is a
  comfortable eight-to-ten-minute video.

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
- **Never** "only a human can merge" — merge is default-deny for agents and
  needs an explicit `project.cr.merge` grant. That is the stronger claim anyway.
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

Screenshots must be capped in `vh` — `imgClassName="max-h-[48vh] object-cover
object-top"` keeps the top of the screen and crops the empty bottom rather than
letterboxing. A slide is one viewport and must never scroll.

## QA before delivery — do not skip

```bash
cd apps/web
npx tsc --noEmit            # must be clean in src/app/presentations
npx eslint src/app/presentations   # 0 errors
```

Then drive it in the browser (chrome-devtools MCP):

1. Every slide renders — press `G` for the overview, which shows all slides
   **fully built**, and check it in one screenshot.
2. Step at least one build slide by hand and confirm each press adds one stage.
3. Both themes. Screenshots embedded in a dark-themed deck read as bright
   panels — check it, don't assume.
4. Console clean.

Reload the page before each check: after a hot reload, accumulated keydown
listeners make one press jump several steps. That is a dev artifact, not a bug.

## The narrow .pptx exception

This directory still carries the OOXML machinery (`editing.md`,
`pptxgenjs.md`, `scripts/`) for the one case it is for: **an external party
requires an actual `.pptx` file** and a link will not do. That is the only
reason to open it.

It is not the Kortix presentation format, it is not a shortcut when the route
feels like more work, and a `.pptx` is never the deliverable for an internal
deck, a product walkthrough, a sales narrative, or a recorded video. If you find
yourself reaching for it, you are building the wrong artifact — build the route.
