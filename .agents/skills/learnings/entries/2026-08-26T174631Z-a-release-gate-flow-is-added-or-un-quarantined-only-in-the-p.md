---
recorded: 2026-08-26T17:46:31Z
incident_date: 2026-08-26
commit: 1a5d77dd69
---
# A release-gate flow is added or un-quarantined only in the PR that carries its green deployed run

**When:** adding a flow with `requires: ['daytona']` (it never runs in local
CI), or deleting a `quarantine:` field. Local lanes skip these flows, so a
green PR proves nothing about them; the first time they execute is the next
production release gate. Two did exactly that in v0.13.6 (gate run
32992496089): SESS-23, un-quarantined in `09aa887a55` with a comment saying
the wake path "must prove the contract on every run", failed on the first run
with the SAME stop→wake 503 its old quarantine text described; CONN-26, a
new real-LLM flow (`gpt-5.6-luna` must call `add_connector` within 300 s),
added in `5b070ebb18` by direct push, timed out at 392 s and left no
transcript. Each cost a staging hotfix + rebuild + redeploy (~25 min) inside
the release, on top of a GitHub Actions outage.
Rules: (1) the PR that adds or un-quarantines a deployed-only flow links a
green `tests-release.yml` dry run (`gh workflow run tests-release.yml --ref
staging -f expected_sha=<sha>`) — no link, no merge; (2) an LLM-behaviour
flow captures the transcript on timeout, or it cannot be diagnosed from CI;
(3) a `quarantine:` text is a claim about the product — re-quarantine with the
new evidence rather than arguing with the old text. Re-quarantined in
#6927/#6928 (SESS-23) and #6929/#6930 (CONN-26).
*Enforcer:* none — a check that a PR touching `quarantine:` or a
`requires: [... 'daytona']` flow links a tests-release run is the TODO.
