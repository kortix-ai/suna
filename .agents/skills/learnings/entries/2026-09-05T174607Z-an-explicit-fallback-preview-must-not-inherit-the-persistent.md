---
recorded: 2026-09-05T17:46:07Z
incident_date: 2026-09-05
commit: 41dac74227
---
# An explicit fallback preview must not inherit the persistent provider identity

PR #7109 needed Daytona after Platinum failed twice while building its base
template. The manual dispatch selected `daytona`, but the workflow still set
`PREVIEW_BRANCH_ENV` to the pull request branch. The provider guard rejected
Daytona before sandbox creation because that value reserves the stable branch
origin for Platinum.

**The rule.** A manual Daytona fallback verifies the exact pull request SHA on
an ephemeral provider origin. It must leave `PREVIEW_BRANCH_ENV` empty. Normal
automatic and Platinum runs must keep the persistent branch identity.

*Fix:* `deploy-preview.yml` emits an empty `persistent_branch` only for an
explicit workflow-dispatch Daytona run. *Enforcer:*
`tests/unit/web-ecs-workflow.test.ts` asserts both the selection condition and
the deploy environment output.
