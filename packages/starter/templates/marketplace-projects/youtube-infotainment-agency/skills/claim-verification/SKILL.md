---
name: claim-verification
description: Independently fact-check every claim in claims.json by re-fetching its sources, and write fact-check.json with verdicts and evidence. Load for stage 2b fact-checking, or to re-verify claims after a correction or viewer report.
---

# Claim verification (stage 2b)

You are independent of the researcher. Assume every claim is wrong until a source you open yourself
says otherwise. Kurzgesagt found AI research tools produced outlines where only ~80 % of facts traced
to real sources — your job is to make that 100 %.

## For each claim
1. Open each cited source yourself (fresh fetch). Find the quoted passage. Check:
   - the quote exists verbatim (minor whitespace/typography differences are fine);
   - the quote actually supports the claim **as worded** (scope, units, precision, date, hedging);
   - the source is what it says it is (publisher, year, not retracted, not a content farm).
2. For numbers: recompute any derived figure (ratios, unit conversions). Check order of magnitude
   sanity against a second source when the number is load-bearing.
3. Verdict:
   - `supported` — quote found and supports the claim as worded.
   - `partially_supported` — true but over-stated/under-hedged/imprecise → give `corrected_text`.
   - `unsupported` — quote missing, misread, or source contradicts it.
   - `source_unreachable` — you could not open it (paywall, 404). Try archive.org first.
4. `evidence`: one or two sentences on what you read and where.

## Output
`02-research/fact-check.json` (schema `FactCheck`), one result per claim — don't skip any. Copy each
claim's text, exactly as you checked it, into `claim_text`: the research critic may still be reviewing
the dossier, and a claim reworded after your check loses its verdict until you check it again. Then:
```bash
bin/yt claims apply <slug>     # merges verdicts into claims.json statuses
bin/yt claims stats <slug>
bin/yt validate <slug> factcheck
```
If more than 20 % of claims are not `supported`, tell the showrunner — research should be redone
rather than patched.

## Corrections after publication
For a viewer-reported error, re-verify the specific claim(s) the same way, append the result to
fact-check.json with a new `checked_at`, and hand the verdict to the publisher.
