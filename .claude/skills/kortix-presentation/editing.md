# Editing Kortix Decks (templates & existing files)

Unpack → edit XML → validate → pack. Use **absolute paths**. The `office/` scripts use bare `from validators …` / `from helpers …` imports, so run them **from inside `scripts/office/`**; the top-level scripts run from `scripts/`.

## Tools & exact invocation

```bash
DECK=/abs/input.pptx
WORK=/abs/unpacked

# Inspect (run from scripts/ — thumbnail.py namespace-imports office.soffice + needs PIL + soffice)
python -m markitdown "$DECK"
( cd scripts && python thumbnail.py "$DECK" /abs/grid )      # labeled thumbnail grid → /abs/grid.jpg

# Unpack: extract + pretty-print XML + normalize smart quotes to entities
( cd scripts/office && python unpack.py "$DECK" "$WORK" )

# Add slides (top-level scripts; run from skill root)
python scripts/add_slide.py "$WORK" slide2.xml          # clone slide2 → new slideN.xml
python scripts/add_slide.py "$WORK" slideLayout2.xml    # instantiate from a layout
#   → prints  <p:sldId id="…" r:id="…"/>  — you MUST paste it into ppt/presentation.xml <p:sldIdLst>
python scripts/clean.py "$WORK"                          # delete orphaned slides, media, rels, content types

# Pack (+ auto schema-validation against the original)
( cd scripts/office && python pack.py "$WORK" /abs/out.pptx --original "$DECK" )

# Or validate explicitly (run from office/)
( cd scripts/office && python validate.py /abs/out.pptx )
```

`pack.py --validate` defaults to true but only runs when `--original` is given — pass `--original` to validate the edit against the source automatically; otherwise run `validate.py` separately.

## Workflow

1. **Analyze.** `thumbnail.py` + `markitdown`. Map content sections to template layouts.
2. **Restructure.** Unpack, then do all structural changes first: delete unwanted `<p:sldId>` entries from `ppt/presentation.xml`, clone/instantiate with `add_slide.py` (and paste the printed `<p:sldId>` into `<p:sldIdLst>`), reorder. Finish all add/delete before editing content.
3. **Replace content.** Edit each `slide{N}.xml`. Each slide is an independent XML file.
4. **Finalize.** `clean.py`, then `pack.py … --original`.
5. **QA (mandatory).** Run the full 3-step QA from [SKILL.md](SKILL.md): content (`markitdown`) → schema validation → visual render. Do NOT skip visual QA for edits — recolors, reorders, and layout fixes produce bugs that only show in rendered slides.

## OOXML gotchas

- **Bold:** `b="1"` on `<a:rPr>` — not `bold="true"`.
- **One `<a:p>` per logical item** (list row, metric, agenda line). Never concatenate items into one paragraph — it breaks bullets and paragraph formatting.
- **Bullets:** use `<a:buChar>` / `<a:buAutoNum>` / `<a:buNone>` in `<a:pPr>`; inherit from the layout when possible. Never literal `•`.
- **Whitespace:** `xml:space="preserve"` on any `<a:t>` with significant leading/trailing spaces.
- **Curly quotes:** the unpack step normalizes them to ASCII; emit curly quotes as XML entities (`&#x201C;` `&#x201D;` `&#x2018;` `&#x2019;`) — never paste literal curly characters.
- **Use `lxml.etree`** for any manual XML scripting — stdlib `xml.etree` corrupts OOXML namespaces.
- **Spare template slots:** delete the entire shape group (images + text boxes + captions), not just the text — blanking text leaves orphaned visuals.

## Kortix brand on edits

When recoloring or restyling a template, apply [`../brand-guidelines/SKILL.md`](../brand-guidelines/SKILL.md): Kortix neutrals + exactly one accent, Roobert/Inter type, recolor the logo to the surface (composite the official symbol — never redraw), subtle shadows only. Remove any accent underlines, colored side borders, and gradients the original template carried — they are AI/template hallmarks (see SKILL.md → Never).
