# Presentations

Internal decks, as code. Every deck is a route under `/presentations`, styled
like the marketing site, driven by the keyboard, and built to be screen
recorded.

There are no `.pptx` files here and there should never be one. A deck is a
component: it themes correctly, it stays sharp at any projection size, it is
reviewed in a PR, and it cannot drift from the product copy because it imports
the same content modules the marketing pages do.

```
presentations/
  page.tsx            the index — every deck, one card each
  registry.ts         the ONE file you edit to add a deck
  [deck]/             the route: /presentations/<slug>
  decks/<slug>.tsx    a deck: `useSlides(): SlideDef[]`
  engine/
    deck.tsx          keyboard engine, build steps, presenter notes, overview
    parts.tsx         Slide, SectionHead, Panel, RowList, SpecStrip, Shot, Rise…
    diagram.tsx       build-aware mechanism diagrams (Stage, Box, Link, Wall…)
```

## Add a deck

1. Write `decks/<slug>.tsx` exporting `useSlides(): SlideDef[]`.
2. Add a row to `DECKS` in `registry.ts`.

That is the whole procedure. The route, the index card, the slide and build
counts, the length estimate and the page metadata are all derived.

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

**Builds.** `steps: 3` means → is pressed four times on that slide, and `node`
is called with `step` 0…3 so the picture can add a stage each time. Advancing
past the last step moves on; reversing off step 0 lands on the previous slide at
*its* last step, so ← always undoes exactly what → just did.

**Notes** are the words you say. They never render on the stage — only in the
presenter drawer (`N`) — so a recording of the deck stays clean. Pass an array
to give each build step its own line; the drawer follows the step you are on.

## Rules that keep a build readable

- **Never mount or unmount on a build step.** Every element is in the DOM from
  the first frame, ghosted, and a step raises it to full opacity. If parts
  appeared instead, every press would reflow the slide and the viewer would lose
  the thread. `engine/diagram.tsx` does this for you; if you hand-roll, use
  `opacity` transitions, not conditional rendering.
- **The title should not move.** On a build slide the words that change belong
  in the diagram's caption, not the heading.
- **One build, one idea.** If a step needs two sentences of setup, it is two
  steps.

## Keys

`→ / Space / J` next build or slide · `← / K` back · `Home / End` first / last ·
`1–9` jump to slide · `G` overview · `F` fullscreen · `N` presenter notes.

## Copy accuracy

Import copy from the marketing content modules
(`features/marketing/*/content.ts`) rather than retyping it. Those files carry
accuracy gates in their headers — the claims that were checked against shipped
code, and the ones that must not be "restored". A deck that retypes a claim is a
deck that will still be saying it a year after the product stopped doing it.

## Recording

Open the deck, press `F`, and record the tab. Light theme suits the decks that
embed product screenshots, since the screenshots are light. Read the script
first with `N` → **Full script**; close the drawer before you hit record.
