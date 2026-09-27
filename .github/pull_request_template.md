<!--
  Every change to `main`, `staging` or `prod` goes through a pull request (SOC 2 CC8.1).
  Procedure: CONTRIBUTING.md and the `contributing` skill (.agents/skills/contributing).

  - Open as a draft and add the `preview` label. It deploys a full environment for this
    branch and runs the `Tests` suite. `test` runs only the suite.
  - `prod` needs an approving review and the `full suite + quality gates` check.
    `main` / `staging` need the pull request only. The author owns what was verified.
  - This repo is public. Use synthetic data only, in text, screenshots, and video.
-->

## Summary

<!-- What changes, and why. One short paragraph. Link the issue if there is one. -->

Closes #

## Demo video

<!--
  Required. Record the change with agent-browser on this PR's preview
  (`agent-browser record start output/pr/demo.mp4 <preview-origin>/<route> --cursor`).
  Keep the line below. Run from the repo root:
    gh pr edit <pr> --body-file output/pr/body.md --attach ./output/pr/demo.mp4
  gh uploads the file and replaces the path with a video player.
  No user-visible surface: record the terminal or the rendered result, or state why a
  video adds nothing.
-->

![Demo](./output/pr/demo.mp4)

**Preview:** <!-- origin from `.agents/skills/contributing/scripts/preview-origin.sh <pr>` -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / chore
- [ ] Docs / skills
- [ ] Infrastructure / CI
- [ ] Security fix
- [ ] Breaking change

## How was this tested?

<!-- The exact commands and their results. Say whether `pnpm test` ran locally or the
     `test` / `preview` label ran it in CI, and what the preview's `--target-full` reported. -->

## Security & data review

- [ ] No secrets, keys, or credentials are committed (verified by secret scan / review)
- [ ] Authorization checks are in place for any new/changed endpoints (IAM / access control)
- [ ] User input is validated (e.g. Zod) and output is safe
- [ ] No sensitive data (tokens, PII, secrets) is written to logs
- [ ] No customer names, people's names, emails, or real prod IDs in the code, commits, this PR text, or the demo video (AGENTS.md → "NEVER write customer data or PII")
- [ ] DB schema / migration changes are reviewed and reversible
- [ ] Touches auth / IAM / crypto / billing / migrations → requested the relevant code owner

## Rollout / rollback

<!-- Migrations, feature flags, env vars, and how to revert if this misbehaves. -->

## Reviewer checklist

- [ ] Change is scoped and understandable
- [ ] The demo video shows the change working
- [ ] Tests cover the change, and the suite passed (locally or via the `test` / `preview` label)
- [ ] Security & data review above is satisfied
