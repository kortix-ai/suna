# Generating Word Documents from Scratch

Use JavaScript and the `docx` module to build .docx files programmatically, then run the validator to catch structural issues.

## Workflow

1. **Initialize** -- load the library, set up the document skeleton
2. **Configure pages** -- dimensions, margins, portrait vs. landscape
3. **Define typography** -- heading overrides, body font defaults
4. **Assemble content** -- paragraphs, lists, tables, images, hyperlinks, tab stops, columns
5. **Export** -- write the buffer to disk, run validation

## Initialization

```javascript
const fs = require('fs');
const docx = require('docx');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  ImageRun, Header, Footer, AlignmentType, PageOrientation, LevelFormat,
} = docx;
const {
  ExternalHyperlink, InternalHyperlink, Bookmark,
  TableOfContents, HeadingLevel,
  BorderStyle, WidthType, ShadingType, VerticalAlign, PageNumber,
  PageBreak, FootnoteReferenceRun,
} = docx;

const report = new Document({ sections: [{ children: [/* ... */] }] });
Packer.toBuffer(report).then(buf => fs.writeFileSync("deliverable.docx", buf));
```

Validation runs automatically when you share the file. If issues are reported, unpack the file, correct the XML, and repack (see EDITING.md).

## Page configuration

### Paper dimensions

The library defaults to A4 paper. When targeting US Letter, you must specify dimensions explicitly.

All measurements use DXA units (twentieths of a typographic point). One inch equals 1440 DXA.

| Format | Width (DXA) | Height (DXA) | Printable area with 1-inch margins |
|--------|-------------|---------------|-------------------------------------|
| US Letter | 12240 | 15840 | 9360 |
| A4 | 11906 | 16838 | 9026 |

```javascript
sections: [{
  properties: {
    page: {
      size: { width: 12240, height: 15840 },
      margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
    }
  },
  children: [/* ... */]
}]
```

### Landscape mode

The library performs an internal width/height swap for landscape pages. Supply the standard portrait values and set the orientation flag -- the engine handles the rest.

```javascript
size: {
  width: 12240,
  height: 15840,
  orientation: PageOrientation.LANDSCAPE
},
// Usable horizontal space in landscape = long edge minus both margins
// 15840 - 1440 - 1440 = 12960 DXA
```

## Typography and heading styles

Pick a professional, universally installed sans-serif font as your base. Check `skills/GENERAL-KNOWLEDGE-WORKER/design-foundations/SKILL.md` for typeface recommendations. Keep heading text in black to ensure legibility.

Override the built-in heading style definitions by referencing their canonical IDs. The `outlineLevel` property is mandatory -- without it, Table of Contents generation will not pick up these headings.

```javascript
const report = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 24 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 36, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 280, after: 140 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 220, after: 110 }, outlineLevel: 1 } },
    ]
  },
  sections: [{
    children: [
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Key Findings")] }),
    ]
  }]
});
```

## Lists

**Do not insert bullet characters directly** -- raw Unicode bullets (`\u2022`) will not produce proper list formatting in Word.

```javascript
const report = new Document({
  numbering: {
    config: [
      { reference: "bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      { reference: "steps",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ]
  },
  sections: [{
    children: [
      new Paragraph({ numbering: { reference: "bullets", level: 0 },
        children: [new TextRun("Key takeaway")] }),
      new Paragraph({ numbering: { reference: "steps", level: 0 },
        children: [new TextRun("First action")] }),
    ]
  }]
});
```

Numbering sequences: paragraphs sharing the same `reference` value form one continuous sequence (1, 2, 3 ... 4, 5, 6). Paragraphs using a different `reference` start a fresh sequence (1, 2, 3 ... 1, 2, 3).

## Tables

You must set widths in two places: on the table object and on every individual cell. Omitting either causes inconsistent rendering across platforms.

**Avoid `WidthType.PERCENTAGE`** -- Google Docs does not handle percentage-based table widths correctly. Stick to `WidthType.DXA`.

**Avoid `ShadingType.SOLID`** -- this fills cells completely black. Use `ShadingType.CLEAR` with a `fill` hex color.

```javascript
const thinBorder = { style: BorderStyle.SINGLE, size: 1, color: "B0B0B0" };
const allBorders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

new Table({
  width: { size: 9360, type: WidthType.DXA },
  columnWidths: [5200, 4160],
  rows: [
    new TableRow({
      children: [
        new TableCell({
          borders: allBorders,
          width: { size: 5200, type: WidthType.DXA },
          shading: { fill: "EDF2F7", type: ShadingType.CLEAR },
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
          children: [new Paragraph({ children: [new TextRun({ text: "Label", bold: true })] })]
        }),
        new TableCell({
          borders: allBorders,
          width: { size: 4160, type: WidthType.DXA },
          shading: { fill: "EDF2F7", type: ShadingType.CLEAR },
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
          children: [new Paragraph({ children: [new TextRun({ text: "Amount", bold: true })] })]
        }),
      ]
    })
  ]
})
```

Sizing guidelines:
- The table `width` must equal the sum of all entries in `columnWidths`
- Each cell's `width` must correspond to its position in the `columnWidths` array
- Cell `margins` define internal padding -- they shrink the content area, not expand the cell
- For edge-to-edge tables: set table width to page width minus left and right margins

## Images

The `type` field is required on every `ImageRun`.

```javascript
new Paragraph({
  children: [new ImageRun({
    type: "png",
    data: fs.readFileSync("diagram.png"),
    transformation: { width: 350, height: 220 },
    altText: { title: "Monthly trend analysis", description: "Line chart of monthly active users Jan-Dec", name: "trend-chart" }
  })]
})
```

Accepted formats: `png`, `jpg`, `jpeg`, `gif`, `bmp`, `svg`

## Hyperlinks

### External links

```javascript
new Paragraph({
  children: [
    new TextRun("Refer to "),
    new ExternalHyperlink({
      children: [new TextRun({ text: "the project wiki", style: "Hyperlink" })],
      link: "https://wiki.example.org"
    }),
    new TextRun(" for background.")
  ]
})
```

### Internal cross-references (bookmarks)

```javascript
new Paragraph({
  children: [
    new Bookmark({ id: "section-data", children: [new TextRun("Data Collection Methods")] })
  ]
})

new Paragraph({
  children: [
    new TextRun("Details are in "),
    new InternalHyperlink({ anchor: "section-data",
      children: [new TextRun({ text: "Data Collection Methods", style: "Hyperlink" })] }),
    new TextRun(".")
  ]
})
```

## Page breaks

Insert a standalone break or trigger one before a specific paragraph. Either way, the break must live inside a `Paragraph` element -- placing it elsewhere produces malformed XML.

```javascript
new Paragraph({ children: [new PageBreak()] })

new Paragraph({ pageBreakBefore: true, children: [new TextRun("Next section begins here")] })
```

## Table of Contents

The TOC scans for paragraphs that use the `HeadingLevel` enum. Paragraphs styled with custom paragraph styles will not appear in the generated TOC, even if they visually resemble headings.

```javascript
new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" })
```

## Headers and footers

```javascript
sections: [{
  properties: {
    page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } }
  },
  headers: {
    default: new Header({ children: [
      new Paragraph({ alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text: "Internal Use Only", italics: true, color: "999999", size: 16 })] })
    ] })
  },
  footers: {
    default: new Footer({ children: [
      new Paragraph({ alignment: AlignmentType.CENTER,
        children: [new TextRun("Page "), new TextRun({ children: [PageNumber.CURRENT] }),
                   new TextRun(" of "), new TextRun({ children: [PageNumber.TOTAL_PAGES] })] })
    ] })
  },
  children: [/* ... */]
}]
```

## Source citations

When content draws on external sources, attach numbered footnotes with clickable links so readers can verify claims.

```javascript
const report = new Document({
  footnotes: {
    1: { children: [new Paragraph({ children: [
      new TextRun("World Bank, Global Economic Prospects, "),
      new ExternalHyperlink({ children: [new TextRun({ text: "https://worldbank.org/en/publication/global-economic-prospects", style: "Hyperlink" })], link: "https://worldbank.org/en/publication/global-economic-prospects" })
    ]})] },
    2: { children: [new Paragraph({ children: [
      new TextRun("NOAA, Annual Climate Report, "),
      new ExternalHyperlink({ children: [new TextRun({ text: "https://ncei.noaa.gov/access/monitoring/monthly-report/global", style: "Hyperlink" })], link: "https://ncei.noaa.gov/access/monitoring/monthly-report/global" })
    ]})] },
  },
  sections: [{
    children: [
      new Paragraph({ children: [
        new TextRun("Emerging economies are projected to grow 4.2% this year"),
        new FootnoteReferenceRun(1),
        new TextRun(", as global average temperatures set another record"),
        new FootnoteReferenceRun(2),
        new TextRun(".")
      ] })
    ]
  }]
});
```

## Rules

- **Specify paper size** -- the library assumes A4 by default; set 12240 x 15840 DXA for US Letter
- **Supply portrait values for landscape** -- the engine swaps dimensions internally when `orientation: PageOrientation.LANDSCAPE` is set
- **Line breaks need separate Paragraphs** -- `\n` inside a TextRun does nothing useful
- **Bullet lists require numbering config** -- inserting raw Unicode bullet characters produces broken formatting
- **Wrap PageBreak in a Paragraph** -- a bare PageBreak generates invalid XML
- **Always declare `type` on ImageRun** -- the library cannot infer the image format
- **Use DXA for all table widths** -- `WidthType.PERCENTAGE` is unreliable in Google Docs
- **Set widths on both the table and each cell** -- the `columnWidths` array and individual cell `width` values must agree
- **Column widths must sum to the table width** -- any mismatch causes layout shifts
- **Include cell margins for readability** -- internal padding keeps text from pressing against borders
- **Apply `ShadingType.CLEAR` for cell backgrounds** -- `SOLID` fills cells with black
- **TOC only recognizes `HeadingLevel`** -- custom paragraph styles are invisible to the TOC generator
- **Reference canonical style IDs** -- use `"Heading1"`, `"Heading2"`, etc. to override built-in styles
- **Set `outlineLevel` on heading styles** -- the TOC needs this property (0 for H1, 1 for H2, and so on)
