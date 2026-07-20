---
name: docx
description: "Use for creating, editing, extracting, converting, and reviewing Word documents."
defaultProjectInstall: true
defaultProjectInstallOrder: 50
---

# Word Document Skill

Under the hood, .docx is a ZIP container holding XML parts. Creation, reading, and modification all operate on this XML structure.

**Visual and typographic standards:** Consult `skills/design-foundations/SKILL.md` for color palette, typeface selection, and layout principles (single accent color with neutral tones, no decorative graphics, WCAG-compliant contrast). Use widely available sans-serif typefaces like Arial or Calibri as your baseline.

## Choosing an approach

| Objective | Technique | Reference |
|-----------|-----------|-----------|
| Create a document from scratch | `docx` npm module (JavaScript) | See CREATION.md |
| Edit an existing file | Unpack to XML, modify, repack | See EDITING.md |
| Pull out text | `pandoc document.docx -o output.md` | Append `--track-changes=all` for redline content |
| Handle legacy .doc format | `soffice --headless --convert-to docx file.doc` | Convert before any XML work |
| Rebuild from a PDF | Run `pdf2docx`, then patch issues | See below |
| Export pages as images | `soffice` to PDF, then `pdftoppm` | See below |
| Flatten tracked changes | `python skills/docx/scripts/accept_changes.py in.docx out.docx` | Requires LibreOffice |

All tools referenced above (`pandoc`, `soffice`, `pdftoppm`, `docx` npm module, `pdf2docx`) are pre-installed in the sandbox.

## Editing professional documents

Finance, legal, and other corporate documents carry conventions that are easy to break without noticing. Honor these whenever you create or edit one — violating them is what makes output read as obviously machine-generated:

- **Format with Word styles, never literal markdown.** Map `#` to a Heading style, `**bold**` to a bold run, `*italic*` to an italic run, and `>` to a block-quote style. Never leave raw `#`, `**`, `>`, or `- ` characters in the document body — literal markdown is the clearest tell that a file was generated. Apply named paragraph styles (Heading 1, Normal) rather than hand-setting fonts, so the document's theme and any brand template stay intact.
- **Treat tracked changes as a record, not scratch space.** If a document already has tracked changes, keep your own edits tracked, and never accept or reject someone else's redlines — each is attributed to a named reviewer. For contract edits, default to a tracked-changes redline and offer a clean accepted copy only if asked.
- **Keep fields and links live.** Cross-references, tables of contents, page numbers, dates, and linked Excel/OLE objects (`REF`, `PAGEREF`, `TOC`, `DATE`, `DOCPROPERTY`, `NUMPAGES`, `LINK`) must stay as fields. Re-typing "Section 2.1" or a linked figure as flat text severs every downstream reference. Don't renumber legal clauses (1.1, (a), (i)) without instruction — referenced numbering will desync.
- **Match the document's number dialect.** Sample existing figures before adding new ones: currency style (`$1.2bn` vs `$1.2B` vs `$1.2MM`), comma separators, decimal precision per column, and negatives in parentheses for finance (`($1,234)`, not `-$1,234`). In legal text, follow the spelled-out-then-numeral convention already in use (`Thirty (30) days`).
- **Defined terms are load-bearing.** In contracts, `"the Agreement"` and `"the agreement"` mean different things. Scan the definitions section and inline `("Defined Term")` / `"Defined Term" means …` patterns, then preserve their exact capitalization, pluralization, quote style (curly vs straight), and emphasis (bold/underline) in any new text you generate.
- **Preserve markings and placeholders verbatim.** Keep confidentiality and privilege banners (`PRIVILEGED & CONFIDENTIAL`, `ATTORNEY WORK PRODUCT`) in the page header, and never add new ones unless asked. Leave deliberate blanks and notes (`[•]`, `[TBD]`, `[NTD: …]`, `[XX]`) untouched — on a "finalize" request, flag what's still missing rather than guessing a value.
- **Don't disturb template scaffolding.** Content controls and custom XML parts databind firm-managed templates. Insert text into a control's range only; never delete the control, rename its tag, or strip XML parts, and don't "tidy" branded tables or theme fonts.
- **Check metadata before sharing.** Before any export or hand-off, scan for leftover tracked changes, comments, hidden text, and author metadata, and surface them — never claim metadata was scrubbed without actually removing it.

## PDF to Word

Start by running `pdf2docx` to get a baseline .docx, then correct any artifacts. Never skip the automated conversion and attempt to rebuild manually.

```python
from pdf2docx import Converter

parser = Converter("source.pdf")
parser.convert("converted.docx")
parser.close()
```

Once you have the converted file, address any problems (misaligned tables, broken hyperlinks, shifted images) by unpacking and editing the XML directly (see EDITING.md).

## Image rendering

```bash
soffice --headless --convert-to pdf document.docx
pdftoppm -jpeg -r 150 document.pdf page
ls page-*.jpg   # always ls to discover actual filenames — zero-padding varies by page count
```

After generating the document, run a verification pass yourself: inspect extracted text, render preview images when useful, and fix issues before delivering the file.