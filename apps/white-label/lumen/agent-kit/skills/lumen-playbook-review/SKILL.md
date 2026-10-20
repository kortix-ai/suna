---
name: lumen-playbook-review
description: Rule-by-rule review of a contract against a firm playbook - the playbook format, status vocabulary, severity rubric and the issues result.
---

# Playbook review

## The playbook format

```
## Rule NDA-01: Confidentiality term
Position: Confidentiality obligations last no more than 3 years from disclosure.
Fallback: Up to 5 years for trade secrets only, if named.
Severity if missed: high
```

The rule id is the text after `Rule ` and before `:`.

## Per rule

1. Find the clause that governs the rule, or confirm that none does.
2. Compare it with the Position, then the Fallback.
3. Status:
   - `aligned` - meets the Position or the Fallback.
   - `deviates` - the clause exists but misses both.
   - `missing` - no clause, and the Position needs one.
4. Severity: the rule's "Severity if missed" for `deviates` and `missing`; `low` for `aligned`.
5. Finding: one or two sentences. Name the clause number and the gap: "Clause 4.2 sets 7 years; the playbook maximum is 3 years."
6. Redline: the smallest edit that reaches the Position, as `{a, from, to, comment}`. `from` is the exact text to replace from that paragraph. `comment` names the rule: "Rule NDA-01: max 3 years." `null` when aligned.
7. Cite the clause (or, for `missing`, the clause where it would belong).

One issue per rule, every rule listed, in playbook order.

## Severity rubric (for `unmatched` clauses)

- High: money or liability exposure, or a firm hard rule (governing law, term).
- Medium: a negotiable deviation.
- Low: drafting.

## Perspective

`perspective` in `input.json` names our client ("Brightwater (recipient)"). A clause that favours the counterparty over our client is the deviation; one that favours our client is aligned.
