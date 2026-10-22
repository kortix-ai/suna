---
name: lumen-research-method
description: How to answer a question from a matter's documents - scope, search, read in context, follow cross-references, answer, cite, state gaps.
---

# Research method

1. **Scope.** `lumen docs --matter <matter_dir>`. Decide which documents can answer the question from their type and name. Say which you will read.
2. **Search with 2 to 3 phrasings.** Lawyers and drafters use different words for one idea:
   - indemnify / hold harmless / reimburse losses
   - limitation of liability / cap / aggregate liability / shall not exceed
   - terminate for convenience / for any reason / without cause / break clause
   - change of control / change in ownership / merger / acquisition of shares
   - assignment / transfer / novation / subcontract
   Use a prefix with `*`: `--query "indemnif* harmless"`.
3. **Read the definitions first.** A defined term ("Losses", "Affiliate", "Confidential Information") changes what a clause means.
4. **Read every hit in context.** `lumen read --doc <id> --anchor <a> --context 2`. A carve-out is often in the next paragraph.
5. **Follow cross-references.** "Subject to clause 14", "except as set out in Schedule 2": read the referenced text before you answer.
6. **Answer.** Short sections. One claim, one citation. Say which document and clause.
7. **State the gaps.** What the documents do not say, and which document is missing (a schedule "omitted from this excerpt", an annex left blank).

## Traps

- "Notwithstanding" clauses override what came before.
- A cap in one clause and an exclusion in another: report both.
- Silence is not permission. A contract with no assignment clause does not say assignment is free; say it does not address assignment.
- Side letters, schedules and annexes may be referenced but not in the vault. Say so.
- Two documents can conflict (an SPA condition and a supply agreement clause). Name both.
