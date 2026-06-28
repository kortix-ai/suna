---
name: design-foundations
description: "Artifact-agnostic design guidance — works for CSS, PowerPoint, matplotlib, PDF, or any visual output."
---

# Design Foundations

Artifact-agnostic design guidance — works for CSS, PowerPoint, matplotlib, PDF, or any visual output.

## Core Principles

1. **Restraint** — 1 accent + neutrals. 2 fonts max, 2-3 weights. Earn every element; decoration must encode meaning.
2. **Purpose** — Every choice answers "what does this help the viewer understand?" Color encodes meaning, type size signals hierarchy, spacing groups content, animation reveals information.
3. **No decoration** — Do not add illustrations, stock images, decorative icons, or clip art unless explicitly requested. Typography, whitespace, and layout are the primary visual tools.
4. **Accessibility** — WCAG AA contrast (4.5:1 body, 3:1 large text). Never rely on color alone. 12px text floor, 16px body copy. Respect `prefers-reduced-motion`.

---

# Color — Default Palette & Accessibility

## Philosophy: Earn Every Color

Color is emphasis — every non-neutral color must answer: **what does this help the viewer understand?** The viewer's eye goes where color is; if everything is colored, nothing stands out.

**Target:** 1 accent + 0-2 semantic colors (error/warning/success). Everything else neutral. Squint at your output — you should see a calm, mostly-neutral surface with 1-2 small moments of color.

---

## Default Palette — Nexus

**Use when the user gives no color direction.** Kortix-aligned default palette — warm, professional, accessible.

**These are roles, not a mandate.** A typical output uses Background + Text + Primary. Add semantic colors (error, warning, success) only when the content requires them. Do not introduce color for decoration.

### Light Mode

| Role | Hex | Usage |
|---|---|---|
| Background | `#F7F6F2` | Primary background |
| Surface | `#F9F8F5` | Cards, containers |
| Surface alt | `#FBFBF9` | Secondary surface layer |
| Border | `#D4D1CA` | Dividers, card borders |
| Text | `#28251D` | Primary body text |
| Text muted | `#7A7974` | Secondary text |
| Text faint | `#BAB9B4` | Placeholders, tertiary |
| Primary | `#01696F` | Links, CTAs (Hydra Teal) |
| Primary hover | `#0C4E54` | Hover state |
| Error | `#A12C7B` | Destructive states |
| Warning | `#964219` | Caution states |
| Success | `#437A22` | Confirmation states |

### Dark Mode

| Role | Hex | Usage |
|---|---|---|
| Background | `#171614` | Primary background |
| Surface | `#1C1B19` | Cards, containers |
| Surface alt | `#201F1D` | Secondary surface layer |
| Border | `#393836` | Dividers, card borders |
| Text | `#CDCCCA` | Primary body text |
| Text muted | `#797876` | Secondary text |
| Text faint | `#5A5957` | Tertiary text |
| Primary | `#4F98A3` | Links, CTAs |
| Primary hover | `#227F8B` | Hover state |
| Error | `#D163A7` | Destructive states |
| Warning | `#BB653B` | Caution states |
| Success | `#6DAA45` | Confirmation states |

### Extended Palette (data visualization only)

| Name | Light | Dark |
|---|---|---|
| Orange | `#DA7101` | `#FDAB43` |
| Gold | `#D19900` | `#E8AF34` |
| Blue | `#006494` | `#5591C7` |
| Purple | `#7A39BB` | `#A86FDF` |
| Red | `#A13544` | `#DD6974` |

**Data visualization naturally needs extra colors** to distinguish categories and series — that's legitimate. But those colors should fit within the overall art direction, not be random. Derive chart colors from the project's accent (monochromatic shades work well for sequential data) or use the curated chart color sequence below. The key: chart colors should feel like they belong in the same design system as the rest of the page.

---

## Custom Palettes

When the user provides color direction **or the content suggests a natural accent** (e.g., finance → navy, sustainability → green): start with that primary as accent → derive surfaces by desaturating → keep semantic colors recognizable (red=error, green=success) → build light AND dark → test contrast (body 4.5:1, large text 3:1). If neither user direction nor content suggest a clear hue, use the Nexus palette above.

---

## Color Accessibility (Non-Negotiable)

- **WCAG AA:** Body text 4.5:1, large text (18px+/14px bold) 3:1
- **Color independence:** Never rely on color alone — add labels, patterns, icons
- **Colorblind safety:** Avoid red/green only. Blue/orange is safer. 8% of men have red-green deficiency
- **Test:** Screenshot and verify contrast. Use DevTools audit for CSS, visual check for slides/charts

---

# Typography — Selection, Hierarchy, Pairing

Type principles for any visual artifact.

---

## Foundational Rules

1. **Readable measure:** 45-75 characters/line (66 ideal). Drives container widths and font sizes.
2. **Leading:** 1.5-1.6× body, 1.15-1.25× headings. Sans-serifs need more.
3. **Typographic color:** Consistent word-spacing. Never letterspace lowercase. Flush-left/ragged-right for screen.
4. **Proportional scales:** Each size step marks a content role change. Same role = same size everywhere.
5. **Content-sympathetic typefaces:** Font chosen for novelty rather than sympathy with content fights the reader.

---

## Economy

- **3-4 text styles** per page/slide (title, heading, body, caption)
- **2 fonts max** (display + body). Weight and size for variation, not extra typefaces.
- **2-3 weights** per font. Regular + bold covers most needs.

---

## Display vs. Body

| Type | Min screen | Min print/slides | Use for |
|---|---|---|---|
| Display | 24px | 18pt | Titles, heroes, covers |
| Body | 12px | 9pt | Body, bullets, captions |
| Body bold (heading) | 18px | 14pt | Section headings |

Never set display fonts below 24px/18pt. Never use body fonts at hero sizes expecting drama.

---

## Serif vs. Sans-Serif

- **Sans-serif** for UI, dashboards, data, product interfaces, documents, and slides. Better at small sizes. Natural default for professional output.
- **Serif** for editorial, long-form, or explicitly formal contexts. Adds authority and rhythm. Use for headings only — not body text in documents or slides.
- Below 14px/10pt, always use sans-serif.
- **Documents & slides default to professional sans-serif** unless the content calls for a formal/editorial tone.

---

## Font Strategy by Format

Font selection is fundamentally different depending on the output format. Each format has different constraints and different expectations for distinctiveness:

| Format | Strategy | Why |
|---|---|---|
| **Websites** | Intentionally selected distinctive fonts loaded via CDN. **Prefer Fontshare** (less overexposed) over Google Fonts. The font IS the design — it should match the art direction. | Websites load any font via CDN. System fonts are fallback only. |
| **PDFs** | Same quality as web — embed any TTF. Download from Google Fonts at runtime. | PDFs embed fonts automatically. Use professional, distinctive fonts. |
| **Slides (PPTX)** | System fonts only — Calibri, Trebuchet MS, Arial, Georgia. | PPTX cannot embed fonts. The viewer must have the font installed. |
| **Documents (DOCX)** | System fonts recommended — Arial, Calibri. | Documents must render correctly on the viewer's machine. |

### Brand Fonts (Fallback Defaults)

When no font direction is given:

| Purpose | Brand font | Free web alt | Free PDF alt (embed TTF) | Free slide alt (system only) |
|---|---|---|---|---|
| Headlines | FK Grotesk (500-700) | Satoshi / General Sans | DM Sans Bold / Work Sans SemiBold | Calibri Bold / Trebuchet MS |
| Body | FK Grotesk (400-500) | Satoshi / Inter | Inter / DM Sans | Calibri / Arial |
| Code | Berkeley Mono (400) | JetBrains Mono / Fira Code | JetBrains Mono | Consolas / Courier New |

---

## Font Rules

**Blacklisted:** Papyrus, Comic Sans, Lobster, Impact, Jokerman, Bleeding Cowboys, Permanent Marker, Bradley Hand, Brush Script, Hobo, Trajan, Raleway, Clash Display, Courier New (body).

**Overused on the web (never use as the primary font for websites):** Roboto, Arial, Helvetica, Open Sans, Lato, Montserrat, Poppins. System fonts (Arial, Helvetica, Georgia, Calibri, Times New Roman, Verdana, Tahoma, Trebuchet MS) belong in the fallback stack only — never as the chosen font. Every website loads a distinctive font via CDN; system fonts are the safety net if loading fails. For slides and documents where embedding isn't available, system fonts are fine as the primary choice.

**Vary across projects** — never reuse the same combination twice in a row.

---

## Size Hierarchy

| Role | Web (px) | Slides (pt) |
|---|---|---|
| Hero / Cover | 48-128px | 44-72pt |
| Page / Slide title | 24-36px | 36-44pt |
| Section heading | 18-24px | 20-28pt |
| Body | 16-18px | 14-18pt |
| Captions / Labels | 12-14px | 10-12pt |

**Floor:** 12px / 9pt absolute minimum for any text.

---

## Slides Pairings (System Fonts Only — No Embedding)

PPTX cannot embed fonts. Use only fonts installed on the viewer's machine:

| Heading | Body | Tone |
|---|---|---|
| Trebuchet MS Bold | Calibri | Modern, clean |
| Calibri Bold | Calibri Light | Minimal, corporate |
| Arial Black | Arial | Bold, direct |
| Georgia | Calibri | Classic, formal |
| Cambria | Calibri | Traditional |

## PDF Pairings (Embedded — Same Fonts as Web)

PDFs embed TTF fonts automatically. Download from Google Fonts at runtime:

| Heading | Body | Tone |
|---|---|---|
| DM Sans Bold | Inter | Modern, clean |
| Work Sans SemiBold | Work Sans | Minimal, versatile |
| Instrument Serif | DM Sans | Editorial, sophisticated |
| Source Serif 4 Bold | Source Sans 3 | Traditional, authoritative |

Fallback: Helvetica (built-in, no download needed).

---

# Data Visualization — Colors, Charts, Design

Principles for charts, graphs, and data visualizations across all formats (web, Python, PowerPoint, documents).

Principles for charts, graphs, and data visualizations across all formats.

---

## Chart Color Sequence

Use in order for data series (bar, pie, line, scatter):

| # | Hex | Name |
|---|---|---|
| 1 | `#20808D` | Teal (chart primary — distinct from Nexus UI teal `#01696F`) |
| 2 | `#A84B2F` | Terra/rust |
| 3 | `#1B474D` | Dark teal |
| 4 | `#BCE2E7` | Light cyan |
| 5 | `#944454` | Mauve |
| 6 | `#FFC553` | Gold |
| 7 | `#848456` | Olive |
| 8 | `#6E522B` | Brown |

**Fit chart colors to the art direction.** Data viz naturally needs multiple colors to communicate — that's fine. But choose them thoughtfully: for sequential data, use monochromatic shades of the primary accent. For categorical data that needs distinct hues, use the curated sequence above — it's designed to be harmonious. When the project has a custom palette, derive chart colors from it rather than defaulting to unrelated hues. The chart colors should feel like part of the same design system as the rest of the page.

**Rules:** ≤5 series per chart (use small multiples beyond that). Sequential data: single hue, varying lightness. Diverging data: teal `#20808D` positive, red `#A13544` negative. Highlight key series at full opacity, dim others to 40-60%.

**Colorblind safety:** Never color alone — add labels/patterns/markers. Avoid red/green only. Blue+orange is safer.

---

## Chart Type Selection

| Data question | Chart type | Notes |
|---|---|---|
| Change over time? | Line | Continuous data, trends |
| Category comparison? | Vertical bar | Discrete comparisons |
| Ranking? | Horizontal bar | Easier label reading |
| Part of whole? | Stacked bar / treemap | NOT pie (rarely right) |
| Distribution? | Histogram / box plot | Spread, outliers |
| Relationship? | Scatter | Correlation, clusters |
| Geographic? | Choropleth map (D3, MapLibre, or Mapbox) | Regional comparisons |
| Flow/process? | Sankey / funnel | Conversion, steps |

**Never:** 3D charts, pie with 5+ slices, dual-axis charts.

---

## Data Viz Design Principles

1. **Data-ink ratio** — Every pixel presents data. Remove decorative gridlines, borders, backgrounds.
2. **Label directly** — Labels on/near data points, not in separate legends. Legends only when direct labeling would clutter.
3. **Color with purpose** — Encode a data dimension, never decorate.
4. **Accessible** — Never color alone. 3:1 contrast between adjacent elements. Alt text or data tables as fallback.
5. **Animate transitions** — Numbers count up, bars grow, lines draw (600-800ms). No gratuitous effects.

---

## Typography in Charts

- Body font only — never display fonts
- Axis labels: 12-14px / 10-12pt
- Titles state the insight: "Revenue grew 23% in Q4" not "Revenue Chart"
- `tabular-nums lining-nums` on all numeric values

---

## KPI Cards

- **Value:** Large, bold — dominant element
- **Label:** Small, muted
- **Delta:** Colored arrow + %. Teal/green up, red down, gray flat
- **Sparkline (optional):** Tiny trend line, no axes
- **Animate** value on change/appear