# Charts & Data Visualization (Web-Specific)

For universal data visualization principles (data-ink ratio, chart type selection, chart color sequence, labeling rules, KPI card patterns), see `skills/GENERAL-KNOWLEDGE-WORKER/design-foundations/SKILL.md`.

This file adds **web-specific** library recommendations, CSS token integration, and implementation patterns.

---

## Library Recommendations

### Vanilla HTML/CSS/JS Projects

| Library | Level | Best For | CDN |
|---|---|---|---|
| **Chart.js** | High-level | Quick charts — line, bar, doughnut, radar. Animated by default. | `<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>` |
| **D3.js** | Low-level | Fully custom visualizations, force-directed graphs, complex layouts. | `<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>` |
| **Observable Plot** | Mid-level | Quick exploratory charts with a concise API. Built on D3. | `<script src="https://cdn.jsdelivr.net/npm/@observablehq/plot"></script>` |

### React Projects

| Library | Level | Best For | Install |
|---|---|---|---|
| **Recharts** | Mid (declarative) | React dashboards, standard chart types. | `npm install recharts` |
| **Nivo** | Mid-high | Rich animated charts with SVG, Canvas, HTML rendering. SSR support. | `npm install @nivo/core @nivo/bar` |
| **Visx** | Low (primitives) | Pixel-level control over custom visualizations. By Airbnb. | `npm install @visx/group @visx/shape` |
| **Tremor** | Very high (meta) | Quick dashboards. Built on Recharts. | `npm install @tremor/react` |

### Decision Guide

| Question | Answer |
|---|---|
| Quick dashboard in React? | **Recharts** |
| Quick chart in vanilla HTML? | **Chart.js** |
| Fully custom, novel visualization? | **D3.js** |
| Geographic / choropleth map? | **D3.js**, **MapLibre GL JS**, or **Mapbox** — see `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/07-toolkit.md` Maps section |
| Need SSR or Canvas rendering? | **Nivo** |
| Exploratory data analysis? | **Observable Plot** |

---

## Web Design Rules for Charts

### Chart Color Direction
**Data viz needs extra colors — but they should fit the art direction.** Multiple hues are natural for distinguishing categories and series. For sequential data, use monochromatic shades of the primary accent. For categorical data, use the curated chart color sequence from `skills/GENERAL-KNOWLEDGE-WORKER/design-foundations/SKILL.md` or derive harmonious hues from the project's palette. The chart colors should feel like part of the same design system — not random or disconnected from the page's visual identity.

### Typography & Color
See `skills/GENERAL-KNOWLEDGE-WORKER/design-foundations/SKILL.md` for chart typography rules and chart color sequence. CSS token mapping: body font → `--font-body`, axis labels → `--text-xs`/`--text-sm`, titles → `--text-base`/`--text-lg` bold, tooltips → `--text-sm`. Always `font-variant-numeric: tabular-nums lining-nums`.

### Layout
- Minimum `--space-8` padding around chart containers
- Charts in dashboards fill their grid cell — never hardcode dimensions
- Use `ResponsiveContainer` (Recharts) or `responsive: true` (Chart.js)
- On mobile: full-width charts. Rotate axis labels or switch chart type if needed

### Animation
- Entry: bars grow from baseline, lines draw left-to-right, donuts sweep clockwise
- Value change: morph to new values (don't rebuild)
- Duration: 600-800ms with the golden easing curve
- Respect `prefers-reduced-motion`

### Interaction
- Hover tooltips on nearest data point, not requiring precise mouse placement
- Click-to-drill-down for composite metrics
- Cross-chart highlighting — hovering a category highlights it in adjacent charts
- Touch: larger hit areas, swipe-to-pan for time series

---

## Sparklines

Tiny inline charts — no axes, no labels, just the data shape. Use in table cells, KPI cards, or alongside text.

```css
.sparkline {
  display: inline-block;
  width: 80px;
  height: 24px;
  vertical-align: middle;
}
```

Use Chart.js with all axes hidden, or draw with SVG `<polyline>` for minimal overhead.

---

## KPI Cards (Web Tokens)

Pattern from `skills/GENERAL-KNOWLEDGE-WORKER/design-foundations/SKILL.md`. Web token mapping: value → `--text-xl`/`--text-2xl` + `tabular-nums`, label → `--text-xs`/`--text-sm` + `--color-text-muted`, delta → `--color-success` (up) / `--color-error` (down) / `--color-text-faint` (flat). Animate with NumberFlow (React) or CSS `@property` counter.
