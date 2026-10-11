---
recorded: 2026-10-08T20:35:27Z
incident_date: 2026-10-08
---
# After a region switch, move every reader of the env blobs in the same change; aws-env reads each blob only from its blob_region row

**Rule:** When an env blob moves region, edit its row in `blob_region` in
`.github/actions/aws-env/fetch.sh`. Remove the row of the old copy, then delete
the old copy. Never give the action a per-step region. A blob without a row
fails before any read.

**Trigger surface:** Moving an environment's stack, or its Secrets Manager
blob, to another region. Adding a new blob that a workflow reads through
`aws-env`.

**Incident:** 2026-10-08, a near-miss after the dev (us-east-2) and staging
(eu-west-2) switch on 2026-10-06 (#9230, #9254).
- **What went wrong:** the action defaulted every read to us-west-2. Five
  workflows still read the stale us-west-2 copies: Tests - release, Tests -
  browser quarantine (nightly), Deploy Preview, DB Drift Sentinel and Deploy
  Dev. CloudTrail showed 331 such reads in 48 hours. The release gate read
  `kortix-staging-env` from a copy last written 2026-10-06T13:08, while staging
  ran on the eu-west-2 copy, written 2026-10-07T17:04.
- **Blast radius:** none yet. All 13 keys these workflows read had the same
  value in both copies. The next staging-only key change, or the phase-4
  deletion of the old copies, would have tested the release with stale
  credentials or failed every one of those runs.
- **The per-step `aws-region` input was the trap:** #9293 and #9301 each
  failed a Deploy Staging run by pointing a whole step at a region where one of
  its blobs did not exist.

**Enforcement:** `tests/unit/aws-env-action.test.ts`:
- "every blob a workflow reads through aws-env has a row in the region table"
  goes red for a blob without a row;
- "passes no aws-region to aws-env" goes red for a per-step region;
- "fails before any AWS call when a blob has no row in the region table".
