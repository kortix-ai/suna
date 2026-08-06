---
name: convert-documents-to-markdown
description: "Convert Word (.doc, .docx), PowerPoint (.ppt, .pptx), Excel (.xls, .xlsx), OpenDocument (.odt, .ods, .odp), RTF, EPUB, CSV, and PDF files to GitHub-Flavored Markdown. Use when a task needs the contents of an office document, spreadsheet, presentation, ebook, or PDF you cannot read directly."
defaultProjectInstall: true
defaultProjectInstallOrder: 30
metadata:
  source: firecrawl/anydoc
---

# Convert documents to Markdown

The `anydoc` CLI is pre-installed in the sandbox. It converts one document per
invocation and writes GitHub-Flavored Markdown to stdout. It never prompts;
diagnostics go to stderr.

## Usage

```bash
anydoc report.docx                  # Markdown to stdout
anydoc slides.pptx -o slides.md     # write to a file
anydoc - --format csv < data.csv    # read stdin (stdin needs --format for CSV)
```

Supported inputs: Word (.doc, .docx, .docm), PowerPoint (.ppt, .pptx, .ppsx),
Excel (.xls, .xlsx, .xlsb), OpenDocument (.odt, .ods, .odp), RTF, EPUB, CSV,
and PDF. The format is detected from file content; pass `--format <name>` when
detection fails (stdin CSV, missing extensions).

Exit codes: `0` success, `1` the document could not be read or converted,
`2` usage error.

## Guidelines

- For a large document, write to a file with `-o` and read the parts you need
  instead of streaming the whole conversion into context.
- Scanned or image-only PDFs need OCR, which anydoc does not do — they exit `1`.
  Use the OCR path in `skills/pdf/SKILL.md` (`pytesseract` + `pdf2image`).
- anydoc is read-only extraction. To create or edit files, use the format's own
  skill: `skills/docx`, `skills/xlsx`, `skills/presentations`, `skills/pdf`.
- For layout-aware PDF extraction (tables with coordinates, per-page bounding
  boxes), use `pdfplumber` from `skills/pdf/SKILL.md`.
