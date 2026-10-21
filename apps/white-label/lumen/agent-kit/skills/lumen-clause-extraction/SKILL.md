---
name: lumen-clause-extraction
description: How to answer review-table columns - formats, normalization, "not found" rules and the commercial preset columns.
---

# Clause extraction

## Formats

| `format` | `value` | Example |
|---|---|---|
| `text` | a string of at most 40 words, the answer first | `"3 years from 1 April 2026"` |
| `yes_no` | `true`, `false` | `true` |
| `date` | ISO `YYYY-MM-DD`, or an ISO duration `P2Y`, `P90D` | `"2026-04-01"` |
| `money` | `{"amount": 2000000, "currency": "GBP"}` | |
| `tag` | one of the column's `options`, exactly | `"England and Wales"` |
| `verbatim` | the exact quote, nothing else | |
| `number` | a JSON number, no unit | `24` |
| `percent` | a JSON number, the percentage (8 % is `8`) | `8` |
| `list` | an array of short strings, one per item, at most 8 | `["Breach", "Insolvency"]` |

## Not found

- If the document has no clause on the column's question, the cell is
  `{"value": null, "not_found": true, "note": "No clause on X; checked clauses 1-14.", "confidence": "high", "citations": []}`.
- `not_found` means the document is silent. It is not "no": a lease with no renewal clause is `not_found`, not `false`.
- Use `false` only when a clause says no ("Neither party may terminate for convenience").

## Termination for convenience

- `true` only for a right to end the agreement with no trigger: "for convenience", "for any reason", "without cause", a break clause on notice.
- A right that arises only on an event is not convenience: breach, insolvency, force majeure, change of control, a condition precedent not met, a long-stop date ("if Completion has not occurred by 31 December 2026, either party may terminate"). Such a right alone is `not_found`, with the clause named in `note`.

## Normalization

- Durations as written plus a number: "seven (7) years" -> `"7 years from each disclosure"`.
- Parties: the legal names, comma separated, with their role: `"Brightwater Example Holdings Ltd (Customer), Quillon Analytics Inc. (Supplier)"`.
- Governing law: the jurisdiction only: `"England and Wales"`, `"State of New York"`.
- Caps: the rule, then the amount: `"Uncapped: neither party's liability is limited"`, `"12 months' fees"`, `"GBP 2,000,000 per year"`.

## Confidence

- `high` - one clause answers it directly.
- `medium` - you combined clauses, or a defined term changes it.
- `low` - the wording is ambiguous. Say why in `note`.

## The commercial preset

| key | question |
|---|---|
| `parties` | Who are the parties? |
| `term` | How long does the agreement, or its main obligation, last? |
| `auto_renewal` | Does the agreement renew automatically? (`yes_no`) |
| `termination_convenience` | Can a party terminate without cause, for convenience, or under a break clause? Event-triggered rights do not count. (`yes_no`) |
| `liability_cap` | Is liability capped, and at what amount? |
| `governing_law` | Which law governs the agreement? |
| `assignment` | Can a party assign the agreement, and on what condition? |
| `change_of_control` | Does the agreement contain a change-of-control provision: a consent requirement, condition or termination right triggered by a change of control of a party or of the target? (`yes_no`) |
