---
recorded: 2026-08-28T13:51:46Z
incident_date: 2026-08-28
commit: 0f683cedda
---
# `deploy-preview.yml` runs from the DEFAULT BRANCH, so everything it references must be on main

**When:** adding anything the preview deploy touches — a file under `tests/`, a
Cloudflare worker under `infra/cloudflare/workers/`, a script it shells out to —
while developing on a feature branch. The workflow is `pull_request_target`, and
its deploy and teardown jobs check out
`${{ github.event.repository.default_branch }}`, NOT the pull request head. The
PR's own code is only ever built into the images; the ORCHESTRATION is main's.

Hit twice in one afternoon. First the branch-environment machinery
(`previewSandboxIdentity`, sandbox reuse, the Caddy reload) lived only on the
feature branch, so the label flow could not have used it. Then the `pi-router`
worker did, and the deploy failed with
`infra/cloudflare/workers/pi-router/wrangler.toml does not exist` — the file was
right there in the branch being deployed, and irrelevant.

**The rule: if the preview WORKFLOW reads it, it ships to main first** — as its
own PR, ahead of the feature that needs it. A feature branch may only contribute
images.

**Diagnostic:** a preview step that cannot find a file which plainly exists on
your branch is this, every time. `git ls-tree -r --name-only origin/main -- <path>`
settles it in one command.
*Near-miss:* PR #7019. The guard failed loudly with the exact path rather than
proceeding, which is why it cost one run and not an afternoon.
*Enforcer:* none for the general case. Each referenced path needs its own
existence check in the step that uses it, the way the worker step now has one.
