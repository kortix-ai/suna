---
name: pdf
description: "Use for creating, editing, extracting, OCRing, filling, and converting PDF documents."
---

# PDF Processing

## Quick Start

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("document.pdf")
print(f"Pages: {len(reader.pages)}")

text = "".join(page.extract_text() or "" for page in reader.pages)
```

Use this for fast inspection. Move to the tool-specific sections below when you need layout-aware extraction, OCR, forms, rendering, or creation.

## When to Use Which Tool

| Task | Tool | Details |
|------|------|---------|
| Create PDF from scratch | ReportLab | [libraries/reportlab.md](libraries/reportlab.md) |
| Read / merge / split / rotate / encrypt | pypdf | — |
| Extract text and tables | pdfplumber | [libraries/pdfplumber.md](libraries/pdfplumber.md) |
| Render pages to images | pypdfium2 | [libraries/pypdfium2.md](libraries/pypdfium2.md) |
| Create/manipulate in JavaScript | pdf-lib | — |
| CLI merge/split/encrypt/optimize/repair | qpdf | [libraries/cli-tools.md](libraries/cli-tools.md) |
| CLI text extraction | pdftotext | [libraries/cli-tools.md](libraries/cli-tools.md) |
| CLI image extraction | pdfimages | [libraries/cli-tools.md](libraries/cli-tools.md) |
| CLI page rendering | pdftoppm | [libraries/cli-tools.md](libraries/cli-tools.md) |
| OCR scanned PDFs | pytesseract + pdf2image | Convert to images, then OCR |
| Fill PDF forms | pypdf or pdf-lib | [form-filling.md](form-filling.md) |
| Convert PDF to Word | pdf2docx (load docx skill) | See docx skill — Converting PDF to Word |

**Form filling:** You MUST read [form-filling.md](form-filling.md) before attempting to fill any PDF form.

## Design and Typography

**Design defaults:** See `skills/GENERAL-KNOWLEDGE-WORKER/design-foundations/SKILL.md` for palette, fonts + PDF pairings, chart colors, and core principles (1 accent + neutrals, no decorative imagery, accessibility).

**Typography:** PDFs embed any TTF font — use distinctive, professional fonts, not system defaults. Download from Google Fonts at runtime, register with ReportLab, and it embeds automatically. See [libraries/reportlab.md](libraries/reportlab.md) (Custom Fonts section) and `skills/GENERAL-KNOWLEDGE-WORKER/design-foundations/SKILL.md` (PDF Pairings table + Font Strategy by Format). Default to a clean sans-serif (Inter, DM Sans, Work Sans).

**CJK text:** Fonts like Inter and DM Sans only cover Latin glyphs. ReportLab has no automatic font fallback — unregistered scripts render as tofu. Register Noto Sans CJK for Chinese, Japanese, or Korean text. See [libraries/reportlab.md](libraries/reportlab.md) (CJK Font Support).

## PDF Metadata

Always set metadata when creating PDFs:
- **Author** should default to `"Kortix"` unless the user asks for a different organization or author name
- **Title** should be a descriptive name relevant to the document contents

Canvas API: `c.setTitle(...)`, `c.setAuthor("Kortix")` right after creating the canvas.
SimpleDocTemplate: pass `title=...`, `author="Kortix"` as constructor kwargs.
pdf-lib (JS): `doc.setTitle(...)`, `doc.setAuthor("Kortix")`.

## Source Citations

Every PDF that includes information from web sources MUST have:
1. Numbered superscript footnote markers in body text (using `<super>` tags, never Unicode superscripts)
2. A numbered source list at the bottom of each page with clickable hyperlinked URLs

Each footnote entry must include the actual URL wrapped in an `<a href>` tag — never omit the URL or substitute a plain-text source name. See [libraries/reportlab.md](libraries/reportlab.md) (Source Citations) for the implementation pattern.

## Hyperlinks

All URLs in generated PDFs must be clickable. In ReportLab Paragraph objects, use `<a href="..." color="blue">` markup. On the canvas, use `canvas.linkURL(url, rect)`. See [libraries/reportlab.md](libraries/reportlab.md) (Hyperlinks).

## Subscripts and Superscripts

**Never use Unicode subscript/superscript characters** in ReportLab PDFs. Built-in fonts lack these glyphs, rendering them as black boxes. Use `<sub>` and `<super>` XML tags in Paragraph objects. For canvas text, manually adjust font size and y-offset. See [libraries/reportlab.md](libraries/reportlab.md) (Subscripts and Superscripts).

## Tips

**Text extraction:** `pdftotext` is the fastest option for plain text. Use pdfplumber when you need tables or coordinate data — don't use `pypdf.extract_text()` on large documents, it's slow.

**Image extraction:** `pdfimages` extracts embedded images directly and is much faster than rendering whole pages. Only render with pypdfium2 or pdftoppm when you need a visual snapshot of the page layout.

**Large PDFs:** Process pages individually or in chunks rather than loading the entire document. Use `qpdf --split-pages` to break up very large files before processing.

**Encrypted PDFs:** Use `pypdf` to detect and decrypt (`reader.is_encrypted` / `reader.decrypt(pw)`). If you don't have the password, try `qpdf --password=X --decrypt`. Run `qpdf --show-encryption` to inspect what protection is applied.

**Corrupted PDFs:** Run `qpdf --check` to diagnose structural problems, then `qpdf --replace-input` to attempt repair.

**Text extraction fails:** If pdfplumber or pdftotext return empty/garbled text, the PDF is likely scanned images. Fall back to OCR (see below).

## OCR for Scanned PDFs

```python
import pytesseract
from pdf2image import convert_from_path

pages = convert_from_path("scan_output.pdf", dpi=300)
ocr_text = "\n\n".join(
    f"--- Page {n} ---\n{pytesseract.image_to_string(pg)}"
    for n, pg in enumerate(pages, 1)
)
```
