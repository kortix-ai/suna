# Creating Kortix Decks with PptxGenJS

The non-obvious behaviors and corruption risks. Examples use Kortix tokens (see [SKILL.md](SKILL.md) → brand rules). **Colors are 6-char hex with NO `#`.**

## Setup

```javascript
const pptxgen = require("pptxgenjs");
const deck = new pptxgen();
deck.layout = "LAYOUT_16x9"; // 10" x 5.625"
const sl = deck.addSlide();
sl.background = { color: "0A0A0A" };        // dark title surface
// ... build slides ...
await deck.writeFile({ fileName: "/abs/out.pptx" });   // forgetting await truncates the file
```

After `writeFile`, **always** run the QA gate from SKILL.md: `repair.py` then `office/validate.py`. Raw pptxgenjs output is not schema-valid until repaired.

Layout sizes: `LAYOUT_16x9` 10×5.625", `LAYOUT_16x10` 10×6.25", `LAYOUT_4x3` 10×7.5", `LAYOUT_WIDE` 13.33×7.5".

## Color: no `#`, no 8-char hex

Always 6-char hex without `#`. `"2B91F7"` is correct; `"#2B91F7"` corrupts the file; 8-char alpha hex (`"2B91F780"`) also corrupts it — use the `opacity` / `transparency` property instead. Applies everywhere: text `color`, `fill.color`, `line.color`, shadow `color`, `chartColors`.

## Object mutation → use factory functions

PptxGenJS mutates style objects in place during render (points → EMU). Reusing one object across calls feeds later calls already-transformed numbers. Always build fresh via a factory:

```javascript
const card = () => ({
  fill: { color: "F3F3F3" },                                  // Kortix card surface
  shadow: { type: "outer", color: "1A1F2E", blur: 6, offset: 2, angle: 90, opacity: 0.04 },
});
sl.addShape(deck.shapes.ROUNDED_RECTANGLE, { x: 0.5, y: 1.2, w: 4.3, h: 2.8, rectRadius: 0.1, ...card() });
sl.addShape(deck.shapes.ROUNDED_RECTANGLE, { x: 5.2, y: 1.2, w: 4.3, h: 2.8, rectRadius: 0.1, ...card() });
```

## Text

- **`breakLine: true`** on every segment except the last in a multi-segment `addText` array, or segments concatenate onto one line.
- **`charSpacing`** — not `letterSpacing` (which is silently ignored).
- **`margin: 0`** — text boxes have built-in inset padding; zero it so text starts exactly at `x`.
- **`lineSpacing` vs `paraSpaceAfter`** — `lineSpacing` changes wrapped-line AND paragraph gaps together (inflates bulleted lists). Use `paraSpaceAfter` for space between bullet items only.
- Use Roobert with fallbacks: `fontFace: "Roobert"` for display/body, `"Roobert Mono"` for product nouns/paths; pptxgenjs falls back to Inter/system if absent.

## Bullets

Body-sized text (14–16pt), lists of 3+ items only. Never `bullet` on text above 30pt (the glyph scales into an eyesore). Never put a literal `"•"` in the string — pptxgenjs adds its own. Custom char: `{ bullet: { code: "2022" } }` (en-dash `"2013"`, square `"25AA"`).

## Shapes & rounded rectangles

`rectRadius` only affects `ROUNDED_RECTANGLE` (no-op on `RECTANGLE`, no error). Don't overlay a thin rectangular accent bar on a `ROUNDED_RECTANGLE` — the bar's square corners expose the clipped rounding. Use plain `RECTANGLE` when a card needs an accent stripe. **But per Kortix brand: avoid accent side-stripes on cards entirely** — separate blocks with surface color or whitespace.

## Shadows

- **Negative offset corrupts the file.** To cast upward, use `angle: 270` with a positive `offset`.
- No 8-char hex — use `opacity` (0.0–1.0).
- Factory function (mutated during render). Keep them subtle (Kortix: low opacity, small offset, no glow).

## Gradients

No gradient-fill API, and gradients are off-brand anyway. If a gradient is unavoidable, generate the image externally and embed via `addImage` or `sl.background = { data: ... }`.

## Backgrounds

`sl.background = { color: "0A0A0A" }` (solid) or `{ data: "image/png;base64,..." }` (image). Simpler than a full-bleed rectangle.

## Images & the logo

`{ sizing: { type: "contain"|"cover"|"crop", w, h } }`. **Composite the Kortix symbol top-left** from the official asset (`addImage` with the symbol file recolored to the surface) — never have the model draw it.

## Charts

Defaults look dated. Non-obvious option names:

- `chartColors` — array of 6-char hex. For sequential data use the Kortix chart ramp: `["FFD230","FE9A00","E17100","BB4D00","973C00"]`. For categorical, derive shades of the single accent.
- `chartArea` `{ fill, border, roundedCorners }`; `plotArea` `{ fill }` (often needed behind data on dark slides).
- `catGridLine` / `valGridLine` `{ color, style, size }` — `style: "none"` hides them.
- `catAxisLabelColor` / `valAxisLabelColor`; `dataLabelPosition` (`"outEnd"|"inEnd"|"center"`); `dataLabelFormatCode` (`'#,##0.0'`, `'#"%"'`).
- `showLabel` / `showValue` / `showPercent`; `barDir` (`"col"|"bar"`); `barGrouping` (`"clustered"|"stacked"|"percentStacked"`); `holeSize` (50–60 for a real doughnut); `lineSmooth`, `showMarker`.
- Scatter: first array is X-values, rest are Y-series — don't use `labels` for X. No waterfall type — build from positioned rectangles.

## Tables

`colW` (inches, sum to table width), `rowH`, `border` `{ type:"solid", color:"E5E5E5", pt:0.5 }`, header `fill: { color:"F3F3F3" }`, per-cell `align`/`valign`/`fontFace`/`fontSize`/`bold`. `autoPage: false` to control pagination.

## Icons

**Omit unless the user asks.** When needed: render react-icons → SVG → sharp → base64 PNG, and **wrap the icon + its backdrop shape in one try/catch** — if the icon throws, skip the backdrop too (an empty circle is a critical visual bug).

```javascript
try {
  const svg = renderToStaticMarkup(React.createElement(Icon, { color: "#FAFAFA", size: "512" }));
  const data = "image/png;base64," + (await sharp(Buffer.from(svg)).png().toBuffer()).toString("base64");
  sl.addShape(deck.shapes.OVAL, { x: 0.6, y: 1.5, w: 0.7, h: 0.7, fill: { color: "2B91F7" } });
  sl.addImage({ data, x: 0.7, y: 1.6, w: 0.5, h: 0.5 });
} catch (_) {}
```

Sets: `react-icons/{fi,hi,md,fa,bi}`. One icon family per deck (Kortix discipline).
