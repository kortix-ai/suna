# ReportLab — PDF Creation

ReportLab creates PDFs from scratch using either the low-level Canvas API or the high-level Platypus layout engine.

## PDF Metadata

Always set metadata on every PDF you create. The author MUST be `"Kortix"` and the title MUST describe the document contents.

- **Canvas**: call `c.setTitle(...)` and `c.setAuthor("Kortix")` immediately after creating the canvas
- **SimpleDocTemplate**: pass `title=...` and `author="Kortix"` as constructor kwargs

## Canvas API

The canvas gives direct control over coordinates, drawing, and text placement. Origin is bottom-left; y increases upward.

```python
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

c = canvas.Canvas("status.pdf", pagesize=letter)
c.setTitle("Q4 Project Status")
c.setAuthor("Kortix")
w, h = letter

c.setFont("Helvetica-Bold", 18)
c.drawString(72, h - 72, "Q4 Project Status")

c.setFont("Helvetica", 11)
c.drawString(72, h - 100, "Prepared for the engineering leadership team.")

c.setStrokeColorRGB(0.8, 0.8, 0.8)
c.line(72, h - 110, w - 72, h - 110)

c.save()
```

## Platypus (SimpleDocTemplate)

Platypus builds PDFs from a list of flowable objects — paragraphs, tables, spacers, page breaks. The engine handles pagination, line wrapping, and page layout automatically.

```python
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch

doc = SimpleDocTemplate(
    "sprint_review.pdf",
    pagesize=letter,
    title="Sprint 14 Review",
    author="Kortix",
)
styles = getSampleStyleSheet()
story = []

story.append(Paragraph("Sprint 14 Review", styles["Title"]))
story.append(Spacer(1, 0.2 * inch))
story.append(Paragraph(
    "This sprint delivered the new search ranking pipeline and "
    "resolved three P0 incidents in the ingestion layer.",
    styles["Normal"],
))
story.append(PageBreak())
story.append(Paragraph("Metrics", styles["Heading1"]))
story.append(Paragraph("Latency p99 dropped from 420ms to 180ms.", styles["Normal"]))

doc.build(story)
```

## ParagraphStyle

Create custom styles by inheriting from a base style:

```python
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.colors import HexColor

styles = getSampleStyleSheet()
body = ParagraphStyle(
    "Body",
    parent=styles["Normal"],
    fontName="Inter",
    fontSize=10,
    leading=14,
    spaceAfter=8,
    textColor=HexColor("#1a1a1a"),
)
```

## Tables

```python
from reportlab.platypus import Table, TableStyle
from reportlab.lib import colors

data = [
    ["Milestone", "Status", "Owner"],
    ["API v2", "Complete", "Platform"],
    ["Search rerank", "In progress", "ML"],
    ["Dashboard refresh", "Blocked", "Frontend"],
]

table = Table(data, colWidths=[180, 100, 120])
table.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), HexColor("#2d2d2d")),
    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
    ("FONTSIZE", (0, 0), (-1, -1), 10),
    ("ALIGN", (0, 0), (-1, -1), "LEFT"),
    ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, HexColor("#f5f5f5")]),
    ("TOPPADDING", (0, 0), (-1, -1), 6),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
]))
```

## Headers and Footers

Use `onFirstPage` and `onLaterPages` callbacks with `doc.build()`:

```python
def header_footer(canvas_obj, doc):
    canvas_obj.saveState()
    canvas_obj.setFont("Helvetica", 8)
    canvas_obj.drawString(72, 30, f"Page {doc.page}")
    canvas_obj.drawRightString(doc.width + doc.rightMargin, 30, "Confidential")
    canvas_obj.restoreState()

doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)
```

## Subscripts and Superscripts

**Never use Unicode subscript/superscript characters** (like `²`, `₃`, `⁰`). ReportLab's built-in fonts don't map these codepoints, so they show up as filled rectangles. Use XML tags in Paragraph objects instead:

```python
formula = Paragraph("CO<sub>2</sub> emissions decreased", styles["Normal"])
exponent = Paragraph("E = mc<super>2</super>", styles["Normal"])
```

For canvas-drawn text, manually adjust font size and y-offset — do not use Unicode characters.

## Custom Fonts (Google Fonts)

Download TTF files at runtime from Google Fonts, register with ReportLab, and they embed automatically. See `skills/GENERAL-KNOWLEDGE-WORKER/design-foundations/SKILL.md` for font pairings and rules.

```python
import urllib.request
from pathlib import Path
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase import pdfmetrics

FONT_DIR = Path("/tmp/fonts")
FONT_DIR.mkdir(exist_ok=True)

font_url = "https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf"
font_path = FONT_DIR / "Inter.ttf"
if not font_path.exists():
    urllib.request.urlretrieve(font_url, font_path)

pdfmetrics.registerFont(TTFont("Inter", str(font_path)))
```

**Fallback**: Helvetica (built-in, no download). **Blacklist**: see `skills/GENERAL-KNOWLEDGE-WORKER/design-foundations/SKILL.md` Font Rules.

## CJK Font Support

Fonts like Inter and DM Sans only cover Latin glyphs. ReportLab has no automatic font fallback — unregistered scripts render as tofu boxes. For Chinese, Japanese, or Korean text, register **Noto Sans CJK** from system fonts:

```python
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase import pdfmetrics

CJK_FONT_PATH = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
CJK_BOLD_PATH = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"

# subfontIndex: 0=JP, 1=KR, 2=SC (Simplified Chinese), 3=TC, 4=HK
pdfmetrics.registerFont(TTFont("NotoSansCJK", CJK_FONT_PATH, subfontIndex=2))
pdfmetrics.registerFont(TTFont("NotoSansCJK-Bold", CJK_BOLD_PATH, subfontIndex=2))
```

Use `"NotoSansCJK"` as `fontName` in styles for CJK text. Mix Latin and CJK fonts via separate ParagraphStyles or inline `<font>` tags.

## Source Citations

Every PDF with information from web sources MUST have numbered superscript footnote markers in body text and a numbered source list at the bottom of each page with clickable hyperlinked URLs. Each footnote entry must include the actual URL in an `<a>` tag — never omit the URL or use a plain-text source name.

```python
footnote_style = ParagraphStyle(
    "Footnote", parent=styles["Normal"], fontSize=8, leading=10, textColor="gray",
)

story.append(Paragraph(
    "Revenue grew 18% year-over-year<super>1</super> driven by "
    "expansion in the enterprise segment<super>2</super>.",
    styles["Normal"],
))
story.append(Spacer(1, 40))
story.append(Paragraph(
    '1. SEC Filing 10-K, <a href="https://sec.gov/cgi-bin/viewer?action=view&cik=12345" '
    'color="blue">https://sec.gov/cgi-bin/viewer?action=view&cik=12345</a>',
    footnote_style,
))
story.append(Paragraph(
    '2. Annual Report 2025, <a href="https://example.com/annual-report-2025.pdf" '
    'color="blue">https://example.com/annual-report-2025.pdf</a>',
    footnote_style,
))
```

## Hyperlinks

All URLs in body text must be clickable. In Paragraph objects, wrap text in `<a href="..." color="blue">` tags. On the canvas, use `canvas.linkURL(url, rect)` after drawing the text.

```python
story.append(Paragraph(
    'Full methodology at <a href="https://example.com/methods" '
    'color="blue">https://example.com/methods</a>.',
    styles["Normal"],
))
```
