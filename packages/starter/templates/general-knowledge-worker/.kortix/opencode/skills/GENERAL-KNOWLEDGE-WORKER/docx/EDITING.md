# Modifying Existing Word Documents

To edit a .docx file, unpack it into raw XML, apply your changes, then repack into a new .docx. These three stages must happen in sequence.

## Stage 1: Unpack

```bash
python skills/GENERAL-KNOWLEDGE-WORKER/docx/scripts/unpack.py document.docx working/
```

This command extracts the ZIP archive, reformats all XML for readability, consolidates adjacent runs that share identical formatting, and simplifies sequential tracked changes from the same author. Apostrophes and quotation marks are converted to XML entities so they survive round-trip editing.

Flags:
- `--merge-runs false` -- preserve original run boundaries (skip consolidation)
- `--coalesce-changes false` -- leave tracked change sequences as-is

## Stage 2: Edit XML

All editable content lives under `working/word/`. The primary file is `document.xml`.

### Conventions

**Author name for tracked changes and comments:** use "Kortix" unless the user specifies a different identity.

**Make changes with the Edit tool, not scripts.** Writing a Python script to perform string replacements adds unnecessary indirection. The Edit tool provides a clear before/after view of every modification.

**Typographic quotes in new text:** when inserting content that contains apostrophes or quotation marks, encode them as XML entities to produce proper curly quotes:

Entities and their rendered characters: `&#x2018;` produces a left single quote, `&#x2019;` produces a right single quote or apostrophe, `&#x201C;` produces a left double quote, and `&#x201D;` produces a right double quote.

```xml
<w:t>We&#x2019;re confident the &#x201C;pilot phase&#x201D; succeeded.</w:t>
```

### Tracked changes

**Marking an insertion:**
```xml
<w:ins w:id="1" w:author="Kortix" w:date="2025-09-20T14:00:00Z">
  <w:r><w:t>added material</w:t></w:r>
</w:ins>
```

**Marking a deletion:**
```xml
<w:del w:id="2" w:author="Kortix" w:date="2025-09-20T14:00:00Z">
  <w:r><w:delText>removed material</w:delText></w:r>
</w:del>
```

Within a `<w:del>` block, use `<w:delText>` in place of `<w:t>`, and `<w:delInstrText>` in place of `<w:instrText>`.

**Replacing a specific value** -- wrap the deleted original and inserted replacement around only the changed portion, leaving surrounding text untouched:
```xml
<w:r><w:t>The budget is </w:t></w:r>
<w:del w:id="3" w:author="Kortix" w:date="...">
  <w:r><w:delText>$50,000</w:delText></w:r>
</w:del>
<w:ins w:id="4" w:author="Kortix" w:date="...">
  <w:r><w:t>$75,000</w:t></w:r>
</w:ins>
<w:r><w:t> for this quarter.</w:t></w:r>
```

**Removing an entire paragraph** -- you must also mark the paragraph mark as deleted; otherwise accepting the change leaves behind a blank line:
```xml
<w:p>
  <w:pPr>
    <w:rPr>
      <w:del w:id="5" w:author="Kortix" w:date="2025-09-20T14:00:00Z"/>
    </w:rPr>
  </w:pPr>
  <w:del w:id="6" w:author="Kortix" w:date="2025-09-20T14:00:00Z">
    <w:r><w:delText>This paragraph should be removed entirely.</w:delText></w:r>
  </w:del>
</w:p>
```

**Rejecting another author's insertion** -- nest your deletion inside their insertion block:
```xml
<w:ins w:author="Bob Chen" w:id="10">
  <w:del w:author="Kortix" w:id="20">
    <w:r><w:delText>text they added</w:delText></w:r>
  </w:del>
</w:ins>
```

**Restoring another author's deletion** -- place a new insertion immediately after their deletion (never alter their markup):
```xml
<w:del w:author="Bob Chen" w:id="10">
  <w:r><w:delText>text they struck</w:delText></w:r>
</w:del>
<w:ins w:author="Kortix" w:id="20">
  <w:r><w:t>text they struck</w:t></w:r>
</w:ins>
```

### Editing guidelines

- **Swap out entire `<w:r>` elements** when introducing tracked changes. Do not inject change markup inside an existing run.
- **Carry forward `<w:rPr>` formatting** -- copy the original run's `<w:rPr>` block into both your `<w:del>` and `<w:ins>` runs so bold, font size, and other attributes survive.
- **Element order within `<w:pPr>`**: `<w:pStyle>`, `<w:numPr>`, `<w:spacing>`, `<w:ind>`, `<w:jc>`, `<w:rPr>` last
- **Preserve whitespace**: attach `xml:space="preserve"` to any `<w:t>` element whose text has leading or trailing spaces
- **RSIDs**: must be 8-character uppercase hex values (e.g., `00FD9A12`)

### Comments

The `comment.py` helper manages the boilerplate across multiple XML parts (comments.xml, commentsExtended.xml, etc.):

```bash
python skills/GENERAL-KNOWLEDGE-WORKER/docx/scripts/comment.py working/ 0 "Suggest rephrasing this section for clarity"
python skills/GENERAL-KNOWLEDGE-WORKER/docx/scripts/comment.py working/ 1 "Agreed, see my revision below" --parent 0
python skills/GENERAL-KNOWLEDGE-WORKER/docx/scripts/comment.py working/ 2 "Flagged by legal team" --author "Maria Lopez"
```

After creating the comment entries, insert markers into `document.xml`. Markers sit alongside `<w:r>` elements as siblings -- never nest them inside a run.

**Standalone comment:**
```xml
<w:commentRangeStart w:id="0"/>
<w:r><w:t>highlighted passage</w:t></w:r>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
```

**Threaded reply (id=1 replies to id=0):**
```xml
<w:commentRangeStart w:id="0"/>
  <w:commentRangeStart w:id="1"/>
  <w:r><w:t>passage under discussion</w:t></w:r>
  <w:commentRangeEnd w:id="1"/>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="1"/></w:r>
```

### Images

To embed an image in an existing document:

1. Place the image file in `word/media/`
2. Register a relationship in `word/_rels/document.xml.rels`:
```xml
<Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/chart.png"/>
```
3. Declare the content type in `[Content_Types].xml`:
```xml
<Default Extension="png" ContentType="image/png"/>
```
4. Reference the image in `document.xml` (dimensions use EMUs -- 914400 EMU equals 1 inch):
```xml
<w:drawing>
  <wp:inline>
    <wp:extent cx="4572000" cy="2743200"/>
    <a:graphic>
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic>
          <pic:blipFill><a:blip r:embed="rId8"/></pic:blipFill>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline>
</w:drawing>
```

## Stage 3: Repack

```bash
python skills/GENERAL-KNOWLEDGE-WORKER/docx/scripts/pack.py working/ output.docx
```

This compresses XML whitespace and assembles the final .docx file. Validation (schema compliance, tracked change correctness) runs automatically when the document is shared.
