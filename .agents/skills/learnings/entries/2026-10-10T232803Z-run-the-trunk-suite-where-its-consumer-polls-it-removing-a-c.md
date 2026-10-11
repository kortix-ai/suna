---
recorded: 2026-10-10T23:28:03Z
incident_date: 2026-10-10
---
# Run the trunk suite where its consumer polls it: removing a CI trigger is a contract change, never a cost tweak

**Rule:** Before removing or changing a CI trigger, find every consumer that
reads that workflow's runs (`gh run list --workflow <wf> --event <event>`), and
update the consumer in the same change — or keep the trigger. A removed trigger
silences the consumer silently: it keeps polling an event that never fires and
reports nothing. When a cost argument drives the removal, re-check the premise
(quotas change: a private repo moved to a public one gets free hosted runners)
and state the consumer impact in the same commit.

**Trigger surface:** Editing `.github/workflows/*.yml` triggers; editing the
merge gate's run polling (`--workflow tests.yml --branch dev --event push`);
deciding what runs on a push to the trunk.

**Incident:** 2026-10-10. #8844 (2026-10-03) removed the `push: branches:
[dev]` trigger from `tests.yml` to save Actions minutes. The merge gate's
main-red loop kept polling `--event push` runs — a lane that never ran. The
only trunk signal left was the daily 05:41 UTC schedule, which nothing routed
on: its runs were red on 2026-10-08, 09 and 10 (a git-identity-less runner
failed `fast-boot-bundle.test.ts` three days in a row) and no one noticed
until tip-based workers hit the same reds through the attestation's own gaps
(KRTX-2114: a stale generated manifest and an unsatisfiable flow step sat on
the trunk behind merged PRs). Blast radius: every tip-based worker blocked for
up to a day per red; the reds themselves aged 2–3 days.

**Enforcement:** `tests/unit/sandbox-workflow.test.ts` — "every push to dev
runs the trunk suite" pins `push: branches: [dev]` on `tests.yml`, the
`trunk-report` `if` covering push, and a last-green baseline query without an
`event=schedule` filter; "a push to dev triggers the trunk suite, the cheap
guards, and path-gated infra" pins `tests.yml` in the push-trigger list.
