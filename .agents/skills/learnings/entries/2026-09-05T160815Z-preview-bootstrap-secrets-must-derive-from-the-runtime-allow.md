---
recorded: 2026-09-05T16:08:15Z
incident_date: 2026-09-05
commit: 37fcce15ed
---
# Preview bootstrap secrets must derive from the runtime allowlist

**When:** adding a preview runtime secret. Build the forwarded secret object from
`PREVIEW_RUNTIME_SECRET_ALLOWLIST`; do not duplicate its keys in the default-branch
controller. *Incident:* PR #7109 received `PREVIEW_MANAGED_GIT_GITHUB_TOKEN` in Actions,
but the preview API kept using an under-permissioned App because the controller omitted
the PAT. *Enforcer:* `preview-stack.test.ts` checks every allowlisted key.
