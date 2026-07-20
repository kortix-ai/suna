# Dashboard & Data-Dense Interface Design

**Mandatory shared files (read if not already loaded):** `skills/website-building/shared/01-design-tokens.md`.

Dashboards are the most common source of broken, unusable layouts. Follow these rules strictly.

---

## Dashboard Typography & Voice

**Typography:** Use sans-serif exclusively for all UI elements — navigation, labels, data, buttons, table headers, form fields. Serif is only acceptable in a dashboard logo or decorative brand mark. Data values and numbers must use `font-variant-numeric: tabular-nums lining-nums;` so columns align and digits don't shift width.

**Logo:** When building a dashboard, generate the logo as an inline SVG. Aim for a Paul Rand-inspired aesthetic — geometric, reducible to a single shape or letterform, minimal color (one accent + black/white). The logo should work at 24px and 200px. Avoid gradients, bevels, or illustration-style complexity.

**Copy:** Dashboard copy should be active voice, concise, and scannable. Aim for a maximum of 7 words per label or sentence. Write like a control panel, not a novel:
- "Export CSV" not "Click here to export your data as a CSV file"
- "3 items need review" not "There are 3 items that are currently awaiting your review"
- "Updated 2m ago" not "This data was last updated 2 minutes ago"

---

## Layout Architecture

**The golden pattern — full-viewport, no body scroll:**
```css
html, body { height: 100%; overflow: hidden; margin: 0; }

.dashboard {
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-rows: auto 1fr;
  height: 100dvh;
}

.sidebar {
  grid-row: 1 / -1;
  overflow-y: auto;
  overscroll-behavior: contain; /* CRITICAL */
}

.header {
  grid-column: 2;
  position: sticky; top: 0;
  z-index: 10;
}

.main {
  grid-column: 2;
  overflow-y: auto;
  overscroll-behavior: contain; /* CRITICAL */
}
```

---

## The Nested Scroll Rule

**There must be exactly ONE primary scroll region.** This is non-negotiable.

- The `<body>` should have `overflow: hidden` on dashboard layouts. Only `.main` scrolls.
- Every scrollable container must have `overscroll-behavior: contain` to prevent scroll chaining to parent elements.
- Sidebars should be fully visible without scrolling when possible. If they must scroll, they scroll independently with `overscroll-behavior: contain`.
- **Never nest a scrollable table inside a scrollable card inside a scrollable main area.** If a table overflows, the table's container scrolls horizontally while the main area handles vertical scroll.
- Modals: set `body { overflow: hidden }` when open, restore when closed.

---

## Information Hierarchy

Follow the **inverted pyramid model**:

1. **Top**: KPIs and status (the "are we on track?" line) — high-contrast cards, upper-left placement
2. **Middle**: Trends and comparisons (charts, sparklines) that explain movement
3. **Bottom**: Detail tables with sortable columns, pagination, and drill-down links

Rules:
- **Filters above content**, not hidden in sidebars. Always show what's applied.
- **Group related metrics** — separate unrelated ones with space, not lines.
- **Maximum 5-7 KPI cards** visible at once. More creates analysis paralysis.
- **Sticky table headers**: `thead { position: sticky; top: 0; z-index: 1; }`
- **Skeleton screens must match real layout** — if the skeleton has 3 bars and the content has 5 lines, you've broken the illusion.

---

## Data Visualization Rules

- **Animate number changes** — values should count up/down, not snap.
- **Delta indicators**: arrow + percentage + color (green up / red down / gray flat)
- **Sparklines in table rows** to show trends at a glance
- **Don't refresh everything simultaneously** — stagger data updates to avoid visual chaos
- **Don't rely on color alone** — always pair color with icons, labels, or patterns for accessibility

---

## Performance for Dense UIs

```css
/* Skip rendering off-screen content */
.card-grid > * {
  content-visibility: auto;
  contain-intrinsic-size: 0 200px;
}
```

`content-visibility: auto` tells the browser to skip layout/paint for off-screen elements. For dashboards with 50+ cards or long tables, this is a massive performance win (95%+ browser support).
