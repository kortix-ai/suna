---
name: presentations
description: "Create, manage, validate, preview, and export slide decks and presentations. Build 1920x1080 HTML slide decks (the default, higher-quality path) and export to PDF or PPTX — or produce/edit a fully native, editable PowerPoint (.pptx) file directly when the user needs a plain PowerPoint deliverable. Load this skill when you need to build a slide deck, presentation, or PowerPoint file, or export/edit/validate one."
defaultProjectInstall: true
defaultProjectInstallOrder: 70
---

# Presentations

Two paths, one skill:

1. **HTML deck (default)** — build slides as 1920×1080 HTML (Inter font, D3.js, Chart.js pre-loaded), preview them in a browser, then export to PDF or PPTX. This is the preferred path: richer layouts, easier iteration, nicer visual output. Use this unless the user specifically needs a plain, natively-editable PowerPoint file.
2. **Plain PowerPoint (.pptx)** — generate a deck from scratch with `pptxgenjs`, or edit/repair an existing `.pptx` template directly via its XML. Use this path when the user explicitly asks for a `.pptx`/PowerPoint file to open and edit in PowerPoint/Keynote/Google Slides, or hands you an existing `.pptx` template to modify. See [PPTX-CREATING.md](PPTX-CREATING.md) and [PPTX-EDITING.md](PPTX-EDITING.md).

Both paths share the design guidelines below.

```
SCRIPT=~/.opencode/skills/presentations/presentation.ts
```

## Commands (HTML deck path)

```bash
# Create a slide (content = HTML body only, no html/head/body tags)
bun run "$SCRIPT" create_slide '{"presentation_name":"my-deck","slide_number":1,"slide_title":"Intro","content":"<div style=\"...\">...</div>","presentation_title":"My Deck"}'

# List slides
bun run "$SCRIPT" list_slides '{"presentation_name":"my-deck"}'

# Delete a slide
bun run "$SCRIPT" delete_slide '{"presentation_name":"my-deck","slide_number":2}'

# List all presentations
bun run "$SCRIPT" list_presentations

# Delete a presentation
bun run "$SCRIPT" delete_presentation '{"presentation_name":"my-deck"}'

# Validate dimensions (Playwright)
bun run "$SCRIPT" validate_slide '{"presentation_name":"my-deck","slide_number":1}'

# Export to PDF
bun run "$SCRIPT" export_pdf '{"presentation_name":"my-deck"}'

# Export to PPTX (screenshot-based: editable text boxes over a rendered background — fast, good enough for most decks)
bun run "$SCRIPT" export_pptx '{"presentation_name":"my-deck"}'

# Generate viewer HTML (no server)
bun run "$SCRIPT" preview '{"presentation_name":"my-deck"}'

# Start on-demand viewer server (port 3210 by default)
bun run "$SCRIPT" serve '{"port":3210}'
```

## Viewer Server

The viewer is **not** a persistent background service. Start it on-demand with the `serve` action when you need to preview slides:

```bash
bun run "$SCRIPT" serve '{"port":3210}'
```

This starts a Bun server on port 3210 that serves all presentations under the `presentations/` directory. When you need it to keep running, launch the same command in `pty_spawn`.

URL scheme:
- `http://localhost:3210/` — index listing all presentations
- `http://localhost:3210/presentations/<name>/` — viewer for that deck
- `http://localhost:3210/presentations/<name>/slide_01.html` — raw slide file
- `http://localhost:3210/presentations/<name>/download/pdf` — export and download PDF
- `http://localhost:3210/presentations/<name>/download/pptx` — export and download PPTX

The viewer includes PDF and PPTX download buttons by default. They call the
served `/download/pdf` and `/download/pptx` routes, export the current deck on
demand, and return a browser download. For script-only generation, keep using
`export_pdf` and `export_pptx`.

After starting the server, show the URL to the user via `show`:
```
show(action="show", type="url", url="http://localhost:3210/presentations/<name>/", title="Slide Preview")
```

## Slide HTML Rules

- `content` is the `<body>` content only — wrapper injected automatically
- Canvas: 1920×1080px, `box-sizing: border-box`, max 40px padding
- Inter pre-loaded. D3.js v7 + Chart.js 3.9.1 loaded async
- Wrap Chart.js init in `window.addEventListener('load', () => { ... })`
- Images → `presentations/images/` → reference as `../images/filename`

## Layout Patterns

**Title slide:**
```html
<div style="width:1920px;height:1080px;background:linear-gradient(135deg,#1e1b4b,#312e81);
     color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;
     box-sizing:border-box;padding:100px;text-align:center;">
  <div style="font-size:24px;color:#a5b4fc;letter-spacing:4px;text-transform:uppercase;margin-bottom:32px;">SUBTITLE</div>
  <h1 style="font-size:80px;font-weight:800;margin:0;line-height:1.1;">Title</h1>
</div>
```

**Two column:**
```html
<div style="width:1920px;height:1080px;background:#0f172a;color:#f8fafc;
     display:grid;grid-template-columns:1fr 1fr;gap:80px;
     box-sizing:border-box;padding:80px;align-items:center;">
  <div><!-- left --></div><div><!-- right --></div>
</div>
```

**Typography:** Title 64–80px/700+, Subtitle 36–48px, Body 28–36px, min 18px

## Workflow (HTML deck path)

```
create_slide × N → validate_slide → serve → show viewer URL → user can download PDF/PPTX from viewer
```

---

## Design Guidelines (applies to every deck — HTML or PPTX)

Also see `skills/design-foundations/SKILL.md` for palette, fonts + pairings, chart colors, and core principles (1 accent + neutrals, no decorative imagery, accessibility). Below is **slides-specific** guidance.

### Before Starting

- **No icons** unless the user explicitly asks. Icons next to headings, in colored circles, or as bullet decorations are visual clutter. Only include icons when data or content requires them (chart selector, logo).
- **Accent at 10-15% visual weight**: Neutral tones fill backgrounds and body text (85-90%). Never give multiple hues equal weight.
- **Dark/light contrast**: Dark backgrounds for title + conclusion slides, light for content ("sandwich" structure). Or commit to dark throughout for a premium feel.
- **Commit to a structural motif**: Pick ONE structural element and repeat it — rounded card frames, consistent header bars, background color blocks, or bold typographic weight. Carry it across every slide. Avoid colored side borders on cards (a hallmark of AI-generated slides).

### Color Selection

**Derive color from the content itself.** Don't pick from a preset list — let the subject matter guide the accent:

- *Financial report* → deep navy or charcoal conveys authority
- *Sustainability pitch* → muted forest green ties to the topic
- *Healthcare overview* → calming blue or teal builds trust
- *Creative brief* → warmer accent (terracotta, berry) adds energy

Build every palette as **1 accent + neutral surface + neutral text**. The accent is for emphasis only (headings, key data, section markers) — everything else stays neutral. See `skills/design-foundations/SKILL.md` for the full "Earn Every Color" philosophy, contrast rules, and the custom-palette workflow (user hue → derive surfaces by desaturating → test contrast).

**When no topic-specific color is obvious**, fall back to the Kortix neutral system: black/white or soft off-white neutrals with a single accent such as teal `#22808D` only where emphasis is needed (see `skills/design-foundations/SKILL.md`).

### For Each Slide

**Use layout variety for visual interest** — columns, grids, and whitespace keep slides engaging without decoration.

**Layout options:**
- Two-column (text left, supporting content right)
- Labeled rows (bold header + description)
- 2x2 or 2x3 grid of content blocks
- Half-bleed background with content overlay
- Full-width stat callout with large number and label

**Data display:**
- Large stat callouts (big numbers 60-72pt with small labels below)
- Comparison columns (before/after, pros/cons, side-by-side options)
- Timeline or process flow (numbered steps, arrows)

### Typography

See `skills/design-foundations/SKILL.md` for font pairings (Slides Pairings table) and size hierarchy. Default to professional sans-serif. Use serif for headings only when formal tone is needed.

### Spacing

- 0.5" minimum margins
- 0.3-0.5" between content blocks
- Leave breathing room—don't fill every inch

### Avoid (Common Mistakes)

- **Don't repeat the same layout** — vary columns, cards, and callouts across slides
- **Don't center body text** — left-align paragraphs and lists; center only titles
- **Don't skimp on size contrast** — titles need 36pt+ to stand out from 14-16pt body
- **Don't mix spacing randomly** — choose 0.3" or 0.5" gaps and use consistently
- **Don't style one slide and leave the rest plain** — commit fully or keep it simple throughout
- **Don't rely on plain title + bullets** — use layout variety (columns, stat callouts, grids) for structure; typography and whitespace are your primary visual tools
- **Don't forget text box padding** — when aligning lines or shapes with text edges, set `margin: 0` on the text box or offset the shape to account for padding
- **Don't use low-contrast elements** — text needs strong contrast against the background; avoid light text on light backgrounds or dark text on dark backgrounds
- **NEVER use accent lines under titles** — these are a hallmark of AI-generated slides; use whitespace or background color instead
- **NEVER use colored side borders on cards/shapes** — `border-left: 3px solid <accent>` is another AI-generated hallmark. Use background color, subtle neutral borders, or whitespace to separate content blocks
- **NEVER leave orphan shapes** — if you add a circle/oval as an icon background, the icon MUST render successfully inside it. If the icon fails (import error, sharp error), remove BOTH the icon AND its background shape. A stray white circle on a slide is a critical visual bug.
- **NEVER use `bullet: true` on large stat text** — bullets at 60-72pt render as giant dots. Only use bullets on body-sized text (14-16pt)
- **NEVER use `bullet: true` on all text in a slide** — bullet points should only be used for actual lists of 3+ items. Don't bullet a title, subtitle, description, or stat. Bullets on every text element makes slides look like a Word document
- **NEVER use gradient backgrounds on shapes or text** — solid colors are more professional. Gradients on buttons, cards, or text blocks are a template cliché
- **NEVER use generic filler phrases** — "Empowering your journey", "Unlock the power of...", "Your all-in-one solution". Use specific, concrete language that could only describe this actual content

### Numbers and Charts

Decks for executives and boards live or die on their numbers — sloppy figures read as careless even when the design is clean.

- **Carry numbers across exactly** as the source states them. Don't round, restate, or let a value drift between the data and the slide.
- **Pick one magnitude convention per deck** (`$1.2M`, `$1,200K`, or implied thousands) and apply it to every figure in a table or chart. Never mix suffixed and implied-thousands values in the same view. Use parentheses for negatives in financials (`($1,234)`).
- **Label every unit.** Each metric, axis, and series needs a visible unit ($, %, K/M/bn, headcount). An unlabeled axis forces the reader to guess what they're looking at.
- **Give every chart a title that matches its data.** Catch and fix any chart with a missing title, a title that overstates what the data shows, a missing axis or unit label, or a truncated/zoomed scale that distorts the comparison. Never imply causation the data doesn't establish.

### Source Citations

Every slide that uses information gathered from web sources MUST have a source attribution line at the bottom of the slide using **hyperlinked source names** — each source name is displayed as clickable text linking to the full URL. Always use "Source:" (singular).

In HTML slides, use a normal `<a href="...">` link. In PPTX (pptxgenjs), use an array of text objects with `hyperlink` options:

```javascript
slide.addText([
  { text: "Source: " },
  { text: "Reuters", options: { hyperlink: { url: "https://reuters.com/article/123" } } },
  { text: ", " },
  { text: "WHO", options: { hyperlink: { url: "https://who.int/publications/m/item/update-42" } } },
  { text: ", " },
  { text: "World Bank", options: { hyperlink: { url: "https://worldbank.org/en/topic/water" } } }
], { x: 0.5, y: 5.2, w: 9, h: 0.3 });
```

- Each source name MUST have a `hyperlink.url` with the full `https://` URL — never omit hyperlinks
- WRONG: `"Sources: WHO, Reuters, UNICEF"` (plain text, no hyperlinks)
- WRONG: `"Source: WHO, https://who.int/report/123"` (raw URL in text instead of hyperlink)
- RIGHT: `[{ text: "WHO", options: { hyperlink: { url: "https://who.int/report/123" } } }]` (clickable name)

---

## Export to Plain PowerPoint (.pptx)

Use this path — instead of (or in addition to) the HTML deck's `export_pptx` action — when the user explicitly wants a **plain, fully native PowerPoint file**: generated from scratch for maximum PowerPoint-editability, or built from/edited against an **existing `.pptx` template** the user handed you. The HTML deck's `export_pptx` action is screenshot-based (a rendered background image + overlaid editable text boxes) and is the fastest route to a downloadable `.pptx` — reach for the techniques below when the user needs a deck that's natively structured throughout (every shape, table, and chart is a real PowerPoint object) or needs an existing PowerPoint template edited in place.

### Choosing an approach

| Objective | Technique | Reference |
|-----------|-----------|-----------|
| Extract text or data | `python -m markitdown presentation.pptx` | Also: `scripts/slides.py thumbnail` for visual grid |
| Modify an existing file or template | Unpack to XML, edit, repack | See [PPTX-EDITING.md](PPTX-EDITING.md) |
| Generate a deck from scratch | JavaScript with `pptxgenjs` | See [PPTX-CREATING.md](PPTX-CREATING.md) |

Pre-installed sandbox packages: `markitdown[pptx]`, `Pillow`, `pptxgenjs` (Node), `react-icons` + `react` + `react-dom` + `sharp` (icon rendering), LibreOffice (`soffice`), Poppler (`pdftoppm`), `lxml`.

Scripts live in `skills/presentations/scripts/`: `repair.py` (fix pptxgenjs OOXML bugs), `unpack.py` / `pack.py` (unpack a `.pptx` to editable XML and repack it), `slides.py` (`clean` / `add` / `thumbnail` subcommands for slide-level XML surgery).

### Math and Equations

Render equations with Unicode math symbols only. Do not use OMML or generate equation images — LibreOffice cannot display either during visual QA.

### QA (Required — do not skip any step)

Every plain-PPTX task MUST complete ALL three QA steps below before delivering the file. Skipping any step is a failure.

**Step 1: Content QA.** Run markitdown on the output file and review the extracted text:

```bash
python -m markitdown output.pptx
```

Check for missing content, typos, wrong order. When using templates, check for leftover placeholder text:

```bash
python -m markitdown output.pptx | grep -iE "xxxx|lorem|ipsum|this.*(page|slide).*layout"
```

If grep returns results, fix them before proceeding.

**Step 2: Visual QA via background session.** Use a fresh background session for visual inspection so the reviewer starts with fresh eyes.

1. Convert slides to images:

```bash
soffice --headless --convert-to pdf output.pptx
pdftoppm -jpeg -r 150 output.pdf slide
ls slide-*.jpg   # always ls — zero-padding varies by page count
```

2. Start a background review session using the Kortix session orchestration flow (`session_start_background`, or `session_spawn` if the alias is what the runtime exposes). Give it the slide image paths plus a prompt like this:

```text
Visually inspect these slides. Assume there are issues — find them.

Check for: stray dots/circles (orphan shapes, bullets at display size), overlapping elements, text overflow/cutoff, decorative lines mispositioned after title wrap, source footers colliding with content, elements too close (< 0.3" gaps), uneven spacing, insufficient slide-edge margins (< 0.5"), misaligned columns, low-contrast text or icons, narrow text boxes causing excessive wrapping, and leftover placeholder content.

For each slide, list every issue found, even minor ones.
```

3. Read the result back with `session_read` and treat the returned review as the visual QA checklist.

**Step 3: Fix-and-verify cycle.** Fix every issue the background review session found, then re-verify:

1. Fix issues identified in the review session
2. Re-convert affected slides to images (`soffice` + `pdftoppm`)
3. Re-run visual review through a fresh background session or do a careful final self-check after the issues are resolved

At least one fix-and-verify cycle before delivering the file. Fixes create new problems — always re-check.

### Converting to Images

To re-render specific slides after fixes:

```bash
pdftoppm -jpeg -r 150 -f N -l N output.pdf slide-fixed
ls slide-fixed-*.jpg
```

### Delivering

The deliverable is the **`.pptx` file**, which renders inline for the user. Surface it directly:

```
show(type="file", path="/workspace/output.pptx")
```

Do **not** present the rendered slide JPEGs as the deliverable — those images exist only for visual QA. Showing them instead of the deck gives the user flat pictures they can't open, edit, or download as a real presentation.

### Workflow (plain PPTX path)

```
Generate (pptxgenjs, see PPTX-CREATING.md) or edit (unpack/edit XML/repack, see PPTX-EDITING.md)
  → repair.py (if generated with pptxgenjs) → Content QA → Visual QA (background session) → fix-and-verify → deliver
```
