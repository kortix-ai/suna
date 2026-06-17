# Contributing

## Testing

This repo has one consolidated test framework. See **[TESTING.md](./TESTING.md)** for the
full taxonomy, CI cadences, reporting, and quality gates.

Quick start:

```bash
make install     # test deps + Playwright browser
make fast        # lint + typecheck + unit + smoke (the local loop)
make <lane>      # unit | integration | api | contract | smoke | e2e | visual | a11y |
                 # performance | security | migration | infra | chaos | mutation | pentest
make gates       # evaluate quality gates over test-results/
```

**Test-driven expectation:** when you add or change an HTTP route under `apps/api/src/**`,
add or update the matching `ke2e` flow in `tests/src/flows/` and keep its `meta.routes` in
sync. The coverage gate (`make gates`, and the `qa-pr` workflow) fails on any uncovered or
unknown route. `tests/spec/end-to-end.md` is the human source of truth; see the
`ke2e-tests` agent skill for the full add-a-test workflow.

CI runs the fast lanes on every PR, heavier regression on merge to `main`, and the slow
suites (performance, DAST, mutation, chaos) nightly. A red gate blocks the merge/release.
