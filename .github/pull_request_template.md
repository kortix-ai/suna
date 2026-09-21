<!--
  Every change to `main`, `staging` or `prod` goes through a pull request
  (SOC 2 CC8.1). Fill out each section.
  - `prod`: needs an approving review and the `full suite + quality gates` check.
  - `main` / `staging`: the ruleset requires the pull request only. The author
    owns what was verified before merging.
  - The test suite does not run on a plain PR into `main`. Add the `test` label
    to run it (the `preview` label also runs it), or run `pnpm test` locally.
-->

## Summary

<!-- What does this change do, and why? Link the issue/ticket if there is one. -->

Closes #

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / chore
- [ ] Infrastructure / CI
- [ ] Security fix
- [ ] Breaking change

## How was this tested?

<!-- Commands run, manual steps, screenshots. State what you verified.
     Say whether `pnpm test` ran locally or the `test` label ran it in CI. -->

## Security & data review

- [ ] No secrets, keys, or credentials are committed (verified by secret scan / review)
- [ ] Authorization checks are in place for any new/changed endpoints (IAM / access control)
- [ ] User input is validated (e.g. Zod) and output is safe
- [ ] No sensitive data (tokens, PII, secrets) is written to logs
- [ ] DB schema / migration changes are reviewed and reversible
- [ ] Touches auth / IAM / crypto / billing / migrations → requested the relevant code owner

## Rollout / rollback

<!-- Migrations, feature flags, env vars, and how to revert if this misbehaves. -->

## Reviewer checklist

- [ ] Change is scoped and understandable
- [ ] Tests cover the change, and the suite passed (locally or via the `test` label)
- [ ] Security & data review above is satisfied
