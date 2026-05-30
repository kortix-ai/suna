---
name: pptx
description: "Use for creating, editing, reviewing, and validating presentation decks in PPTX format."
---

# PPTX Skill

## Choosing an approach

| Objective | Technique | Reference |
|-----------|-----------|-----------|
| Extract text or data | `python -m markitdown presentation.pptx` | Also: `slides.py thumbnail` for visual grid |
| Modify an existing file or template | Unpack to XML, edit, repack | See [EDITING.md](EDITING.md) |
| Generate a deck from scratch | JavaScript with `pptxgenjs` | See [CREATING.md](CREATING.md) |

Pre-installed sandbox packages: `markitdown[pptx]`, `Pillow`, `pptxgenjs` (Node), `react-icons` + `react` + `react-dom` + `sharp` (icon rendering), LibreOffice (`soffice`), Poppler (`pdftoppm`).

---

## Math and Equations

Render equations with Unicode math symbols only. Do not use OMML or generate equation images — LibreOffice cannot display either during visual QA.

---

## Design Ideas

**Design defaults:** See `skills/GENERAL-KNOWLEDGE-WORKER/design-foundations/SKILL.md` for palette, fonts + pairings, chart colors, and core principles (1 accent + neutrals, no decorative imagery, accessibility). Below is **slides-specific** guidance only.

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

Build every palette as **1 accent + neutral surface + neutral text**. The accent is for emphasis only (headings, key data, section markers) — everything else stays neutral. See `skills/GENERAL-KNOWLEDGE-WORKER/design-foundations/SKILL.md` for the full "Earn Every Color" philosophy, contrast rules, and the custom-palette workflow (user hue → derive surfaces by desaturating → test contrast).

**When no topic-specific color is obvious**, fall back to the Kortix neutral system: black/white or soft off-white neutrals with a single accent such as teal `#22808D` only where emphasis is needed (see `skills/GENERAL-KNOWLEDGE-WORKER/design-foundations/SKILL.md`).

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

See `skills/GENERAL-KNOWLEDGE-WORKER/design-foundations/SKILL.md` for font pairings (Slides Pairings table) and size hierarchy. Default to professional sans-serif. Use serif for headings only when formal tone is needed.

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

## Source Citations

Every slide that uses information gathered from web sources MUST have a source attribution line at the bottom of the slide using **hyperlinked source names** — each source name is displayed as clickable text linking to the full URL. Always use "Source:" (singular). Use an array of text objects with `hyperlink` options.

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

## QA (Required — do not skip any step)

Every pptx task MUST complete ALL three QA steps below before delivering the file. Skipping any step is a failure.

### Step 1: Content QA

Run markitdown on the output file and review the extracted text:

```bash
python -m markitdown output.pptx
```

Check for missing content, typos, wrong order.

When using templates, check for leftover placeholder text:

```bash
python -m markitdown output.pptx | grep -iE "xxxx|lorem|ipsum|this.*(page|slide).*layout"
```

If grep returns results, fix them before proceeding.

### Step 2: Visual QA via background session

Use a fresh background session for visual inspection so the reviewer starts with fresh eyes.

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

### Step 3: Fix-and-verify cycle

Fix every issue the background review session found, then re-verify:

1. Fix issues identified in the review session
2. Re-convert affected slides to images (`soffice` + `pdftoppm`)
3. Re-run visual review through a fresh background session or do a careful final self-check after the issues are resolved

At least one fix-and-verify cycle before delivering the file. Fixes create new problems — always re-check.

---

## Converting to Images

To re-render specific slides after fixes:

```bash
pdftoppm -jpeg -r 150 -f N -l N output.pdf slide-fixed
ls slide-fixed-*.jpg
```