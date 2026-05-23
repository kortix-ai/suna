# Creating Presentations with PptxGenJS

Non-obvious behaviors, corruption risks, and API quirks to watch for when generating slides.

## Setup

```javascript
const pptxgen = require("pptxgenjs");
const deck = new pptxgen();
deck.layout = "LAYOUT_16x9"; // 10" x 5.625"
const sl = deck.addSlide();
// ... build slides ...
await deck.writeFile({ fileName: "/tmp/output/deck.pptx" });
```

After generating, always run the repair script — PptxGenJS produces files with OOXML bugs (phantom slideMaster entries, invalid ZIP directory entries) that PowerPoint will reject:

```bash
python skills/pptx/scripts/repair.py output.pptx
```

Standard slide dimensions for layout math: `LAYOUT_16x9` is 10" wide × 5.625" tall, `LAYOUT_16x10` is 10" × 6.25", `LAYOUT_4x3` is 10" × 7.5", `LAYOUT_WIDE` is 13.33" × 7.5".

`writeFile` returns a promise. Forgetting `await` produces an empty or truncated file.

## Color: no `#`, no 8-char hex

Always 6-character hex without `#` prefix. `"1E293B"` is correct. `"#1E293B"` corrupts the file. Never use 8-character hex for alpha (e.g. `"1E293B80"`) — this also corrupts the file. Use the dedicated `opacity` or `transparency` property instead.

This applies everywhere: text `color`, shape `fill.color`, `line.color`, shadow `color`, chart `chartColors`.

## Object mutation / EMU conversion

PptxGenJS mutates style objects in place during rendering, converting points to internal EMU units. If you pass the same object to multiple `addShape`/`addText` calls, every call after the first gets already-transformed numbers and produces wrong output. Always use a factory function:

```javascript
const cardStyle = () => ({
  fill: { color: "FFFFFF" },
  shadow: { type: "outer", color: "1E293B", blur: 8, offset: 3, angle: 150, opacity: 0.1 },
});
sl.addShape(deck.shapes.RECTANGLE, { x: 0.5, y: 1.2, w: 4, h: 2.8, ...cardStyle() });
sl.addShape(deck.shapes.RECTANGLE, { x: 5.3, y: 1.2, w: 4, h: 2.8, ...cardStyle() });
```

## Text formatting

- **`breakLine: true`** — Required on every segment except the last in a multi-segment `addText` array. Without it, segments concatenate onto one line.
- **`charSpacing`** — Not `letterSpacing`. The property `letterSpacing` exists but is silently ignored.
- **`margin: 0`** — Text boxes have built-in inset padding. Set `margin: 0` to eliminate it so text starts exactly at the given x coordinate.
- **`lineSpacing` vs `paraSpaceAfter`** — `lineSpacing` adjusts distance between wrapped lines AND between paragraphs simultaneously. On bulleted text this inflates gaps. Use `paraSpaceAfter` to add whitespace only between distinct bullet items.

## Bullets

Bullets belong on body-sized text (14-16pt) in lists of 3+ items. Never use `bullet` on text above 30pt — the glyph scales with font size and becomes an eyesore. Never place a literal Unicode bullet in the string (`"\u2022 Item"`) — PptxGenJS adds its own glyph, producing doubled markers.

Custom bullet characters use Unicode code points: `{ bullet: { code: "2013" } }` for en-dash, `"2022"` for bullet, `"25AA"` for small square.

## Rounded rectangles

`rectRadius` only works on `ROUNDED_RECTANGLE`. Applying it to `RECTANGLE` has no effect and no error.

Do not combine `ROUNDED_RECTANGLE` with a thin rectangular accent bar overlay on one edge — the bar's sharp corners sit on top of the rounded shape, exposing clipped corners. Use plain `RECTANGLE` when a card needs an accent stripe.

## Shadows

- **Negative offset corrupts the file.** To cast a shadow upward, set `angle: 270` with a positive `offset`.
- **8-char hex corrupts the file.** Use `opacity` (0.0-1.0) for shadow transparency, not alpha in the color string.
- **Factory function required** — shadow objects are mutated during render (see above).

## Gradient fills

PptxGenJS has no gradient fill API. Generate a gradient image externally and embed via `addImage` or `sl.background = { data: ... }`.

## Slide backgrounds

Set `sl.background = { color: "1E293B" }` for a solid fill, or `sl.background = { data: "image/png;base64,..." }` for an image. Simpler than adding a full-bleed rectangle.

## Image sizing modes

`contain` — scales to fit within bounds without clipping. `cover` — scales to fill bounds, trimming overflow. `crop` — selects a sub-region from the source. Syntax: `{ sizing: { type: "contain", w: 5, h: 3 } }`.

## Chart styling

Default chart rendering looks dated. Key non-obvious option names:

- `chartColors` — array of 6-char hex, one per series/segment
- `chartArea` — `{ fill: { color }, border: { color, pt }, roundedCorners }` for chart background
- `plotArea` — `{ fill: { color } }` for the plot region behind data (often needed on dark slides)
- `catGridLine` / `valGridLine` — `{ color, style, size }`. Use `style: "none"` to hide
- `catAxisLabelColor` / `valAxisLabelColor` — hex for axis labels
- `dataLabelPosition` — `"outEnd"`, `"inEnd"`, `"center"`
- `dataLabelFormatCode` — Excel-style format string, e.g. `'#,##0.0'` for decimals, `'#"%"'` for percentages
- `showLabel` / `showValue` / `showPercent` — toggle category names, values, or percentages on segments
- `barDir` — `"col"` for vertical columns, `"bar"` for horizontal
- `barGrouping` — `"clustered"`, `"stacked"`, `"percentStacked"`
- `holeSize` — doughnut inner ring diameter (default is small; try 50-60 for a proper doughnut look)
- `lineSmooth` — `true` for bezier-smoothed lines. `showMarker` / `lineDataSymbolSize` for data point dots
- Scatter charts use a different data format: first array element is X-axis values, subsequent elements are Y-series. Do NOT use `labels` for X-values.
- No waterfall/bridge chart type — build manually from positioned rectangles

## Tables

Default tables lack visual polish. Key options:

- `colW` — array of column widths in inches. Must sum to desired table width.
- `rowH` — array of row heights or single value for uniform rows.
- `border` — `{ type: "solid", color: "CCCCCC", pt: 0.5 }` on each cell or as table-level default.
- Cell fill: set `fill: { color: "F1F5F9" }` on header row cells for contrast.
- `align` / `valign` — horizontal and vertical alignment per cell.
- `fontSize`, `fontFace`, `bold` — set per cell or per row via arrays of option objects.
- `autoPage` — set `false` if you want to control pagination yourself.

## Icons

**Omit icons unless the user specifically requests them.** Most business slides are stronger without decorative icons.

When needed, render react-icons to SVG, rasterize with sharp, embed as base64 PNG:

```javascript
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const sharp = require("sharp");
const { HiOutlineLightningBolt } = require("react-icons/hi");

const svg = renderToStaticMarkup(React.createElement(HiOutlineLightningBolt, { color: "#FFFFFF", size: "512" }));
const buf = await sharp(Buffer.from(svg)).png().toBuffer();
const data = "image/png;base64," + buf.toString("base64");
sl.addImage({ data, x: 0.7, y: 1.6, w: 0.5, h: 0.5 });
```

Always wrap icon rendering + backdrop shape in try/catch. If the icon render throws, the backdrop shape must also be skipped — a colored circle with no icon inside is a visual defect:

```javascript
try {
  const icon = await renderIcon(Component);
  sl.addShape(deck.shapes.OVAL, { x: 0.6, y: 1.5, w: 0.7, h: 0.7, fill: { color: "7C3AED" } });
  sl.addImage({ data: icon, x: 0.7, y: 1.6, w: 0.5, h: 0.5 });
} catch (_) {}
```

Available sets: `react-icons/fi` (Feather), `react-icons/hi` (Heroicons), `react-icons/md` (Material), `react-icons/fa` (Font Awesome), `react-icons/bi` (Bootstrap).
