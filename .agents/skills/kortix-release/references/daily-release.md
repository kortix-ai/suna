# Daily production release

`daily-release.yml` snapshots staging at **00:00 Europe/Belgrade** (GitHub's
native IANA scheduling handles CET/CEST). The 17/47-minute ticks only resume;
manual dispatch defaults to read-only and never creates a new daily snapshot.
There is no second automatic production promotion schedule.

The controller reconstructs the cutoff from server-timestamped staging push
history, not user-controlled commit dates. Missing history is a hold, never a
best guess. One open `Daily production release: YYYY-MM-DD` GitHub issue is the
durable ledger. Closed dates cannot restart. One workflow concurrency group
serializes writers; an unfinished date blocks the next one. An immutable
`daily-candidate/YYYY-MM-DD` tag records the original source. A staging source
already published on prod closes as unchanged without dispatch or deployment.

It reuses Promote (staging-SHA path), immutable release branches, Tests - release,
unfiltered CI/migrations/security/Terraform workflows, existing production
approvals and Deploy Prod. Production is pinned for the whole attempt. Missing,
failed, neutral or skipped required checks never admit a candidate. Successful
workflow conclusions are insufficient: their actual jobs must pass too (only
non-executing reporting/rerun control jobs are excepted). A final-head approving
review is required. New migrations additionally require the reviewer's
`Migration costing: verified` attestation after the existing read-only prod
costing procedure. No admin merge or automatic approving review is performed.

A protected SHA-matching merge admits only the tested head. Deploy Prod receives
`expected_sha`; a branch race fails before publication. Completion requires the
exact merge's successful Deploy Prod run, health identity on API/gateway/web,
and read-only HTTP smoke. A failed rollout remains held with the deploy URL and
operator rollback assessment. No automatic DB rollback or destructive action.
Use **kortix-rollback** to assess persisted state and migration compatibility.

## Repair / resume

The factory release source turns held ledgers into deduplicated Linear repair
issues for existing intake; it never starts subworkers itself. Fix the root
cause on dev through normal factory review. Include
`Daily release repair: YYYY-MM-DD` in the repair PR body and get an approval of
its final head. Dispatch Daily production release with `dry_run=false` and
`repair_pr=<merged dev PR>`.

The controller cherry-picks only that reviewed PR delta onto its pinned source
and opens a protected staging PR. Conflicts stop. Review the staging candidate:
it must be **exactly** the fix-only tree, without any later staging work. The
controller refuses a merged staging tree that contains unrelated changes. Once
that tree is staged with successful immutable image manifests, resume without
`repair_pr`: the full gate runs again on a fresh immutable release branch.
Three candidate attempts is the ceiling; then owner reconciliation is required.

Ambiguous writes (interrupted promotion/deploy dispatch) are held instead of
blindly repeated. Inspect the linked runs and use the same pinned SHA for manual
recovery. Never close an unresolved ledger just to start tomorrow's release.

## Tests and safe rehearsal

```
python3 -m unittest discover -s scripts/release -v
python3 scripts/release/daily.py --dry-run
```

The latter reads GitHub without writing or dispatching. Do not manually request
a snapshot or deploy production to rehearse orchestration.
