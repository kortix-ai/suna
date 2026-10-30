---
name: lumen-redlining
description: Minimal, tracked-change redlines and drafting style - how to propose an edit and how to produce the DOCX with `lumen redline`.
---

# Redlining

## Edits

- Change the fewest words that reach the position. Replace "seven (7) years" with "three (3) years", not the whole clause.
- Keep defined terms and the document's style: numbering, "shall", capitalisation, numbers written "three (3)".
- One edit per paragraph. If a paragraph needs two changes, make one edit that covers both.
- Every edit has a comment that names the rule: "Rule NDA-04: governing law must be England and Wales, New York or Delaware."
- To add a missing clause, edit the paragraph it belongs after: `from` is its last sentence, `to` is that sentence plus the new one.

## The DOCX

```bash
cat > /tmp/edits.json <<'JSON'
[{"a": "p1.9", "from": "seven (7) years", "to": "three (3) years", "comment": "Rule NDA-01: max 3 years."}]
JSON
lumen redline --docx "<original .docx path>" --edits @/tmp/edits.json --out <batch_dir>/out/redline.docx
lumen redline verify --docx <batch_dir>/out/redline.docx    # insertions, deletions, comments
```

The output shows each edit as a tracked deletion and insertion by "Lumen", with the comment. For a PDF or TXT source, pass `--doc <doc_id>` instead of `--docx`: Lumen redlines a converted copy and the lawyer sees that it is a copy.

`missing` in the output lists edits whose `from` text was not found. Fix `from` to the exact words and run it again.

## Drafting from a template

- Fill `{{fields}}` only from `input.json` or a cited source document.
- A field you cannot fill becomes `[[CONFIRM: field]]`. Never invent a party, a date or an amount.
