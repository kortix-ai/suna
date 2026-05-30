---
name: docx
description: "Use for creating, editing, extracting, converting, and reviewing Word documents."
---

# Word Document Skill

Under the hood, .docx is a ZIP container holding XML parts. Creation, reading, and modification all operate on this XML structure.

**Visual and typographic standards:** Consult `skills/GENERAL-KNOWLEDGE-WORKER/design-foundations/SKILL.md` for color palette, typeface selection, and layout principles (single accent color with neutral tones, no decorative graphics, WCAG-compliant contrast). Use widely available sans-serif typefaces like Arial or Calibri as your baseline.

## Choosing an approach

| Objective | Technique | Reference |
|-----------|-----------|-----------|
| Create a document from scratch | `docx` npm module (JavaScript) | See CREATION.md |
| Edit an existing file | Unpack to XML, modify, repack | See EDITING.md |
| Pull out text | `pandoc document.docx -o output.md` | Append `--track-changes=all` for redline content |
| Handle legacy .doc format | `soffice --headless --convert-to docx file.doc` | Convert before any XML work |
| Rebuild from a PDF | Run `pdf2docx`, then patch issues | See below |
| Export pages as images | `soffice` to PDF, then `pdftoppm` | See below |
| Flatten tracked changes | `python skills/GENERAL-KNOWLEDGE-WORKER/docx/scripts/accept_changes.py in.docx out.docx` | Requires LibreOffice |

All tools referenced above (`pandoc`, `soffice`, `pdftoppm`, `docx` npm module, `pdf2docx`) are pre-installed in the sandbox.

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