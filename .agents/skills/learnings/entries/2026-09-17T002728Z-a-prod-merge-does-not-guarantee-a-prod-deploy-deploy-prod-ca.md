---
recorded: 2026-09-17T00:27:28Z
incident_date: 2026-09-16
commit: 038431ed9d
---
# A prod merge does not guarantee a prod deploy — `deploy-prod` can silently not fire

**When:** merging a release PR into `prod` and assuming the pipeline started.
`deploy-prod.yml` declares `on: push: branches: [prod]`, and the v0.13.20
release merge (`7e7f79b579`, 19:31:47Z) produced **no workflow run at all** —
not deploy-prod, not CodeQL, nothing for that SHA. `prod` sat at VERSION
0.13.20 with production still serving 0.13.19 and no run to watch. Recovered
with `gh workflow run deploy-prod.yml --ref prod`, which deployed normally.
The rule: after merging a release PR, ASSERT a run exists for the merge SHA
(`gh run list --workflow=deploy-prod.yml --json headSha`) before you start
watching one; an absent run looks exactly like a slow queue. Never infer the
deploy from the merge. *Incident:* prod v0.13.20; caught within ~2 min because
the run list was checked, not assumed. *Automation:* none — candidate: a
scheduled reconcile that alerts when `prod` HEAD has no deploy-prod run.
