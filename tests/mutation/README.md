# Mutation testing — `tests/mutation`

Mutation testing measures how good the tests actually are: [Stryker](https://stryker-mutator.io/)
deliberately introduces bugs ("mutants") into the source, re-runs the unit tests, and reports how
many mutants the tests caught (killed) versus missed (survived). A high line-coverage number with a
low mutation score means the tests execute code without really asserting on it.

## Run

```bash
npm run test:mutation          # from tests/
# or
npx stryker run mutation/stryker.conf.json
```

Open the report at `test-results/mutation/index.html`.

## What it mutates

The config targets `tests/_support/**` (the shared factories/helpers) as a fast, self-contained
example. Point `mutate` at any package you want graded — e.g. `../apps/api/src/billing/**/*.ts` —
and set `vitest.configFile` to the suite that exercises it.

## Quality gate

- `thresholds.break = 50` — Stryker exits non-zero if the mutation score drops below 50%, so it can
  gate CI. Raise `high`/`low`/`break` as the suite matures.

Mutation testing is **slow** (it runs the test suite once per mutant), so it belongs in the
**nightly** cadence, not on every PR.
