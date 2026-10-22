# pypdfium2 — PDF Rendering

pypdfium2 is a Python wrapper around PDFium (the engine Chrome uses for PDFs). Fast and accurate for rendering pages to images — use it instead of PyMuPDF.

## Render a Single Page

```python
import pypdfium2 as pdfium

pdf = pdfium.PdfDocument("presentation.pdf")
page = pdf[0]
bitmap = page.render(scale=3.0)
img = bitmap.to_pil()
img.save("cover.png", "PNG")
```

## Render All Pages

```python
import pypdfium2 as pdfium

pdf = pdfium.PdfDocument("handbook.pdf")
for idx in range(len(pdf)):
    bitmap = pdf[idx].render(scale=2.0)
    bitmap.to_pil().save(f"slide_{idx + 1}.jpg", "JPEG", quality=85)
```

## Text Extraction

```python
import pypdfium2 as pdfium

pdf = pdfium.PdfDocument("notes.pdf")
for idx in range(len(pdf)):
    content = pdf[idx].get_text()
    print(f"Page {idx + 1} — {len(content)} characters")
```
