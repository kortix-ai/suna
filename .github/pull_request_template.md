<!--
  Every change to a protected branch goes through this PR + review (SOC 2 CC8.1).
  Fill out each section. PRs cannot be merged without a passing CI check and an
  approving review from someone other than the author.
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

<!-- Commands run, manual steps, screenshots. State what you verified. -->

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
- [ ] Tests/CI pass and cover the change
- [ ] Security & data review above is satisfied
