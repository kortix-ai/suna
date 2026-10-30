---
name: lumen-citations
description: How Lumen cites a document - the citation object, how to get anchors, quote rules and `lumen cite check`. Load before writing any claim about a document.
---

# Citations

Lumen shows every citation to a lawyer next to the source passage, and checks it
against the source before the lawyer sees it. A citation that fails the check is
shown as "Citation not found". Get it right the first time.

## The object

```json
{ "doc_id": "<id from lumen docs>", "a": "p3.12", "quote": "verbatim text from that paragraph" }
```

- `a` is the paragraph anchor: `p<page>.<n>`. Take it from `lumen read` or `lumen search`. Never compute it.
- `quote` is copied character for character from ONE paragraph: at most 300 characters, no "..." inside, no paraphrase, case kept.
- Quote the words that prove the claim, not the whole paragraph. 8 to 40 words is right.

## Get anchors

```bash
lumen search --matter <matter_dir> --query "limitation of liability capped"   # hits: doc_id, a, snippet
lumen read --doc <doc_id> --anchor p3.12 --context 1                           # the paragraph and its neighbours
lumen read --doc <doc_id>                                                      # the whole document
```

## Check before you finish

```bash
echo '{"citations": [{"doc_id": "...", "a": "p3.12", "quote": "..."}]}' | lumen cite check
```

| Code | Meaning | Fix |
|---|---|---|
| `not_found` | The quote is not in the document | Copy the exact words from `lumen read` output |
| `wrong_anchor` | The quote is in another paragraph (`fixed_anchor`) | Use `fixed_anchor` |
| `too_long` | Over 300 characters | Quote fewer words |
| `unknown_doc` | No such document | Use a `doc_id` from `lumen docs` |

`lumen result write` runs the same check on every citation in a result and refuses the file until each passes.

## In chat answers

Write each citation as a Markdown link after the claim:
`[1](/cite?d=<doc_id>&a=p3.12&q=<url-encoded quote>)`. `lumen cite check` prints this link as `link` for every citation that passes: paste it, do not encode a quote by hand. A bare `[1]` with no link is not a citation, and Lumen marks the answer as unchecked. Number them in order. Lumen shows each link as a numbered chip that opens the quoted paragraph. Outside the links, name a document by its filename, never by its `doc_id`.

## Examples

Good:
- `{"doc_id": "k17", "a": "p2.9", "quote": "Neither party's liability under or in connection with this Agreement"}` - exact words, one paragraph.
- `{"doc_id": "k17", "a": "p1.4", "quote": "renews automatically for successive periods of one (1) year"}`.
- `{"doc_id": "k22", "a": "p1.6", "quote": "the Customer is entitled to service credits"}`.

Bad:
- `"quote": "liability is unlimited"` - a paraphrase. The document says "shall be limited or capped in amount".
- `"quote": "shall not exceed ... twelve (12) months"` - an ellipsis inside a quote.
- `"a": "3.12"` - not an anchor. Anchors look like `p3.12`.
