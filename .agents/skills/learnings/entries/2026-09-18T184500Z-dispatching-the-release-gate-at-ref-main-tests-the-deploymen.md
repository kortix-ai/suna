---
recorded: 2026-09-18T18:45:00Z
incident_date: 2026-09-18
commit: e7f107f677
---
# Dispatching the release gate at `--ref main` tests the deployment with code it has never contained

**When:** running `tests-release.yml` by `workflow_dispatch`. The ref decides
whose TEST CODE runs; `RELEASE_SOURCE_SHA` only decides which deployment is
asserted. At `--ref main` those two are different trees, and every test added
after the deployed SHA runs against a deployment that lacks its feature. The
failures are indistinguishable from product defects and each one costs a full
triage: the verdict is a git question, not a debugging question.

**Incident:** run `35369184776`, dispatched `--ref main` (`8ea1ec99e8`) against
staging/prod `fa68c114d7` — **142 commits apart**. All 8 failures were
measurement artifacts. `886afa4016`, which added `SESS-32` and its browser
spec, is not even an ancestor of the deployed SHA. Proof the deployment
answered for itself: `PATCH /v1/projects/:id/features` returned
`400 {"error":"Unknown feature flag 'session_transcript_history'"}`, and the
`Git repo` accessibility snapshot carried no `Change` button at all.

**Rule:** dispatch the gate at the ref that is deployed, or assert nothing from
a mismatch. Before triaging any deployed-gate failure, run
`git log -p <deployed-sha>..<test-ref> -- <failing file>` and check the SERVER
or WEB code too — a test present at both SHAs is the only one worth debugging.
The positive control that settles it: run the same test against local code that
has the feature. Here 3 of 4 passed locally unchanged.

**Enforcement:** none. Candidate: `tests-release.yml` fails fast when its own
checked-out SHA is not an ancestor of `RELEASE_SOURCE_SHA`.
