---
recorded: 2026-08-23T18:30:33Z
incident_date: 2026-08-23
commit: e4ec815f21
---
# A channel promotion must evaluate after skipped sibling surfaces

**When:** adding a dev image promotion job after a conditional multi-surface
deploy graph. Start its condition with `always()`, then require the selected
surface's build and verification jobs to report `success` explicitly.
*Incident:* Deploy Dev run `32654029814` deployed API SHA `a48c31be`, but GitHub
skipped the API `:dev` promotion because unrelated surface ancestors skipped.
A self-host deployment stayed on `3926a01a`. *Enforcer:*
`dev-channel-promotion-workflow.test.ts` covers API, gateway, and frontend.
