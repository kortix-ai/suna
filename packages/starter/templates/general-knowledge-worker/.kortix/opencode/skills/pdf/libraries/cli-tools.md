# CLI Tools for PDF Processing

## pdftotext (poppler-utils)

Extract text from PDFs on the command line.

```bash
pdftotext report.pdf report.txt

pdftotext -layout report.pdf report.txt

pdftotext -f 3 -l 7 report.pdf excerpt.txt

pdftotext -bbox-layout report.pdf layout.xml
```

## pdftoppm (poppler-utils)

Render PDF pages to images.

Output filenames are zero-padded based on total page count (e.g. `pg-1.png` vs `pg-01.png` vs `pg-001.png`). Always `ls` to discover actual filenames.

```bash
pdftoppm -png -r 200 report.pdf pages/pg
ls pages/pg-*.png

pdftoppm -png -r 450 -f 2 -l 5 report.pdf hires/pg
ls hires/pg-*.png

pdftoppm -jpeg -jpegopt quality=80 -r 150 report.pdf thumbs/pg
ls thumbs/pg-*.jpg
```

## pdfimages (poppler-utils)

Extract embedded images from a PDF.

```bash
pdfimages -j report.pdf extracted/fig

pdfimages -all report.pdf extracted/fig

pdfimages -list report.pdf
```

## qpdf

Swiss-army knife for PDF structure manipulation.

### Merge

```bash
qpdf --empty --pages intro.pdf body.pdf -- full.pdf
```

### Split

```bash
qpdf manual.pdf --pages . 1-4 -- chapter1.pdf
qpdf manual.pdf --pages . 6-end -- rest.pdf
qpdf --split-pages=5 manual.pdf section_%02d.pdf
```

### Page selection from multiple files

```bash
qpdf --empty --pages report.pdf 1-4 appendix.pdf 1,3 -- bundle.pdf
```

### Rotate

```bash
qpdf scan.pdf straightened.pdf --rotate=+90:1-3
```

### Encryption

```bash
qpdf --encrypt readpw editpw 256 --print=low --modify=none -- draft.pdf locked.pdf

qpdf --show-encryption locked.pdf

qpdf --password=readpw --decrypt locked.pdf open.pdf
```

### Optimize and Repair

```bash
qpdf --linearize draft.pdf web_ready.pdf

qpdf --optimize-level=all bloated.pdf slim.pdf

qpdf --check suspect.pdf
qpdf --replace-input suspect.pdf
```
