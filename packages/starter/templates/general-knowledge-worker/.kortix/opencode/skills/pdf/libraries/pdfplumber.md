# pdfplumber — Text and Table Extraction

pdfplumber extracts text, tables, and layout information from PDFs with precise coordinate data. It excels at structured content extraction.

## Basic Text Extraction

```python
import pdfplumber

with pdfplumber.open("quarterly_report.pdf") as pdf:
    for page in pdf.pages:
        text = page.extract_text()
        print(text)
```

## Table Extraction

```python
with pdfplumber.open("financials.pdf") as pdf:
    for pg_num, page in enumerate(pdf.pages, 1):
        for tbl_idx, table in enumerate(page.extract_tables(), 1):
            print(f"Page {pg_num}, table {tbl_idx}:")
            for row in table:
                print(row)
```

### Tables to DataFrames

```python
import pandas as pd

with pdfplumber.open("financials.pdf") as pdf:
    frames = []
    for page in pdf.pages:
        for table in page.extract_tables():
            if table and len(table) > 1:
                frames.append(pd.DataFrame(table[1:], columns=table[0]))

    if frames:
        combined = pd.concat(frames, ignore_index=True)
        combined.to_excel("extracted.xlsx", index=False)
```

## Advanced Table Settings

For PDFs with irregular table layouts, customize the extraction strategy:

```python
with pdfplumber.open("irregular.pdf") as pdf:
    page = pdf.pages[0]

    settings = {
        "vertical_strategy": "lines",
        "horizontal_strategy": "lines",
        "snap_tolerance": 5,
        "intersection_tolerance": 10,
    }
    tables = page.extract_tables(settings)
```

## Text with Coordinates

Extract individual characters or words with their precise positions:

```python
with pdfplumber.open("document.pdf") as pdf:
    page = pdf.pages[0]

    for word in page.extract_words():
        print(f"{word['text']}  x0={word['x0']:.1f} top={word['top']:.1f}")

    for char in page.chars[:20]:
        print(f"'{char['text']}' at ({char['x0']:.1f}, {char['top']:.1f})")
```

## Bounding Box Extraction

Extract text from a specific rectangular region (left, top, right, bottom):

```python
with pdfplumber.open("document.pdf") as pdf:
    page = pdf.pages[0]
    region = page.within_bbox((50, 80, 350, 300))
    print(region.extract_text())
```

## Visual Debugging

Render a page with table detection overlays for troubleshooting:

```python
with pdfplumber.open("document.pdf") as pdf:
    page = pdf.pages[0]
    preview = page.to_image(resolution=200)
    preview.save("table_debug.png")
```
