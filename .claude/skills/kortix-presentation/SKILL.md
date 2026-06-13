---
name: kortix-presentation
description: Use when creating, editing, extracting, or validating Kortix/Suna .pptx slide decks, pitch decks, or presentations — produces on-brand decks (Kortix colors, Roobert type, symbol logo) and schema-validates them against OOXML before delivery.
---

# Kortix Presentations

On-brand Kortix `.pptx` decks. This skill carries the full Anthropic pptx engine — pptxgenjs creation, OOXML unpack/edit/pack, LibreOffice rendering, and **schema validation against the ECMA-376 / ISO-IEC 29500 XSDs** — and applies the Kortix visual + verbal identity on top.

## Before starting

Read the product marketing context first: if `product-marketing.md` exists, read it and reuse what it covers — only ask for what is task-specific or genuinely missing.

- **Brand source (visual):** Read [`../brand-guidelines/SKILL.md`](../brand-guidelines/SKILL.md) — colors, Roobert typography, logo rules, shadows, spacing. It is the source of truth; if a request conflicts, say so and offer the closest on-brand option.
- **Messaging source (copy):** Read [`../internal-comms/SKILL.md`](../internal-comms/SKILL.md) for positioning, terminology, and the banned-phrases list before writing any on-slide text.

## Choosing an approach

| Objective | Technique | Reference |
|-----------|-----------|-----------|
| Extract text/data | `python -m markitdown deck.pptx` (+ `python scripts/thumbnail.py deck.pptx` for a visual grid) | — |
| Edit an existing deck / template | unpack → edit XML → validate → pack | [editing.md](editing.md) |
| Create a deck from scratch | pptxgenjs (Node) | [pptxgenjs.md](pptxgenjs.md) |

**Requirements:** Node + `pptxgenjs`; Python 3 + `lxml` + `defusedxml` (the validator); LibreOffice (`soffice`) + Poppler (`pdftoppm`) for visual QA; `markitdown` for content QA. If `lxml`/`defusedxml` are missing in a managed environment, install them in a venv. The Kortix sandbox has these preinstalled.

## Kortix brand rules (override generic slide defaults)

- **Color:** Kortix neutrals — light `FFFFFF`/`0A0A0A`, dark `0A0A0A`/`FAFAFA` — plus **exactly one** accent per deck from the brand palette (blue `2B91F7` is the default; yellow `CCA300`, orange `D18B19`, green `8AD693`, purple `AB80D6`, red `F14B4C`). Never a rainbow. Accent at 10–15% visual weight. (Ignore generic "derive accent from content" advice — brand-guidelines is authoritative.)
- **Type:** Roobert (headings + body), Roobert Mono for product nouns / paths / commands; fall back to Inter, then system sans. Weights Regular/Medium/Semibold only. Sizes per the brand-guidelines scale.
- **Logo:** composite the **Kortix symbol** top-left on 16:9 surfaces — **never generate, redraw, or restyle it.** Recolor to surface: near-black `0A0A0A` on light, white `FAFAFA` on dark. Never the white mark on a light background. One mark per surface.
- **Voice:** direct, product-grounded (sessions, repos, sandboxes, skills, change requests). Banned: "unlock productivity", "seamless", "revolutionary", and generic AI claims with no mechanism (see internal-comms).
- **Shadows / spacing:** subtle shadows only (brand-guidelines scale, low opacity, small offset — no glow); 0.5" minimum slide margins, 0.3–0.5" between blocks.

## Design (slides-specific)

- **Structure:** dark title + conclusion, light content in between ("sandwich") — or commit to dark throughout for a premium feel.
- **One structural motif** repeated on every slide: rounded card frames OR a consistent header bar OR background color blocks OR bold typographic weight. Pick one, carry it across.
- **Layout variety** for interest — two-column, labeled rows, 2×2 / 2×3 grids, half-bleed background + overlay, full-width stat callout. Don't repeat one layout; don't fall back to plain title + bullets.
- **Data display:** large stat callouts (60–72pt number + small label), comparison columns, timeline / process flows.

### Never (AI-slide hallmarks)
- NEVER an accent line under a title. NEVER colored side borders on cards (`border-left: 3px solid …`). NEVER gradient fills on shapes or text. NEVER center body text (titles only). NEVER `bullet: true` on large/stat text or on every element. NEVER leave an orphan icon-backdrop shape (if the icon fails to render, remove its circle too). NEVER generic filler phrases.

## Source citations

Every slide using web-sourced information needs a bottom-of-slide attribution with **hyperlinked source names** — `addText` with an array of segments, each source name carrying a `hyperlink.url`. Use "Source:" (singular). Never raw URLs in the text; never a plain unlinked list.

## QA — required, do not skip (work from the skill directory)

1. **Content QA:** `python -m markitdown out.pptx` — check for missing content, typos, order. For templates also run `python -m markitdown out.pptx | grep -iE "xxxx|lorem|ipsum|this.*(page|slide).*layout"` and fix any hits.
2. **Repair + schema validation (the correctness gate):**

   ```bash
   python scripts/repair.py /abs/out.pptx          # fixes pptxgenjs OOXML defects + element order
   ( cd scripts/office && python validate.py /abs/out.pptx )   # run from office/ so its `validators` import resolves; pass an ABSOLUTE path
   ```

   Fix every reported XSD error and re-run until it prints `All validations PASSED!`. (Raw pptxgenjs output is **not** schema-valid until `repair.py` runs — it emits `notesMasterIdLst` out of order.)
3. **Visual QA:** `python scripts/office/soffice.py --headless --convert-to pdf --outdir . out.pptx` → `pdftoppm -jpeg -r 150 out.pdf slide` → `ls slide-*.jpg`. Inspect every slide (fresh eyes / subagent) for stray dots, overlaps, text overflow/cutoff, footer collisions, gaps < 0.3", margins < 0.5", misaligned columns, low contrast, and leftover placeholders. Re-render fixed slides with `pdftoppm -f N -l N`.
4. **Fix-and-verify cycle:** fix issues, then re-run step 2 (validate) and step 3 (render). At least one cycle before delivery — fixes create new problems.

## Math

Render equations with Unicode math symbols only — not OMML or equation images (LibreOffice can't display either during visual QA).
