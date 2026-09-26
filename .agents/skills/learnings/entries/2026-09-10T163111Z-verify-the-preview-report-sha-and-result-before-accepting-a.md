---
recorded: 2026-09-10T16:31:11Z
incident_date: 2026-09-10
commit: 72282af5fc
---
# Verify the preview report SHA and result before accepting a green deployment

**When:** using a persistent branch preview as release evidence. Push deploys
set `PREVIEW_RUN_TESTS=0`; their success comment can still claim tests passed.
Dispatch `deploy-preview.yml` explicitly, then check the report's `gitSha`,
failures, and exclusions. A healthy runtime does not validate a retained report.
*Near-miss:* PR #7190 deployed db5f0714 but retained c6b9685e's report with
13 failures. The misleading green status was caught before staging promotion.
*Enforcer:* manual report inspection; TODO: report skipped tests truthfully.
