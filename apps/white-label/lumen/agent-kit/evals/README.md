# Lumen evals

The answer key for the synthetic dataset (`demo-data/`) and a deterministic
scorer. No LLM judge.

| Suite | Cases | Scored |
|---|---|---|
| extraction | 10 documents × 8 preset columns (`expected.json`) | value per format; the 26 planted absences; a source-checked citation on each correct value |
| citations | every citation of every suite | raw precision (quote at the cited anchor), in-source rate |
| qa | 12 questions (`cases.jsonl`) | facts in the answer; the expected document cited and verified |
| refusal | 5 questions the documents do not answer | `addressed: false` or the refusal sentence, and no unverified citation |

Run (local stack, a ready firm):

```bash
pnpm --filter @kortix/white-label-lumen eval                 # seeds the dataset, starts 19 runs, scores
pnpm --filter @kortix/white-label-lumen eval -- --suite extraction
pnpm --filter @kortix/white-label-lumen eval -- --runs <runId,...>   # re-score finished runs
```

Reports go to `output/legal/evals/<timestamp>.{json,md}` (gitignored). Model
output varies between runs: report the kit version and every failure with
each score.

## Key notes

- `spa-excerpt-aster.pdf` / `termination_convenience` is `absent`. Clause 4.2
  lets either party end the agreement when the condition is not met by the
  long-stop date. That is an event-triggered right, not termination without
  cause. Kit 1.2.0 scored it a wrong `true` (79/80); kit 1.2.1 adds the rule to
  the column prompt and the `lumen-clause-extraction` skill.
