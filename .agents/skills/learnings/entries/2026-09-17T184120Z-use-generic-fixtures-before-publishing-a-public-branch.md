---
recorded: 2026-09-17T18:41:20Z
incident_date: 2026-09-17
commit: f84fb450bf
---
# Use generic fixtures before publishing a public branch

**Rule:** before pushing a public branch, inspect the complete commit diff,
commit message, and PR body for customer names, repository URLs, account IDs,
and project IDs. Use generic fixtures such as `example-org` and `example.test`.
**When:** adding tests or documentation from a customer cutover. *Incident:*
a public PR included a private customer name in a test fixture; deleting the
branch did not make its commit unreachable. *Enforcer:* manual pre-push diff
sweep; an automated fixture privacy gate remains to be built.
