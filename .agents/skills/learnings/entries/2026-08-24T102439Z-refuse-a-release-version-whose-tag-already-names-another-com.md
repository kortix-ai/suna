---
recorded: 2026-08-24T10:24:39Z
incident_date: 2026-08-24
commit: d248584a3a
---
# Refuse a release version whose tag already names another commit

**When:** resolving a production version before migrations or rollout. Check
`refs/tags/vX.Y.Z` first. Permit no tag, or the current prod commit for a rerun.
Do not trust a release action to move a tag: it can silently reuse the existing
ref and publish correct images under a tag that names unrelated code. *Incident:*
v0.13.5 served source `1eb51c95`, while its reused tag named `98843dc5` until
corrected. *Enforcer:* `deploy-prod.yml` version preflight and workflow unit test.
