---
recorded: 2026-11-02T16:27:36Z
incident_date: 2026-11-02
---
# Regenerate every generated file on the staging tree after a stage-fix cherry-pick; dev's copy can list what staging lacks

**Rule:** After you cherry-pick a `dev` commit onto a `stage-fix/*` branch, run the generators on that branch and commit their output: `bash .agents/skills/learnings/scripts/index.sh` and `node packages/ui/scripts/gen-i18n-catalog.mjs`. Never keep `dev`'s copy of a generated file. `dev`'s copy can list a learnings entry or a catalog key from a commit that is not on `staging`. Before you dispatch `promote.yml -f ref=staging`, run both on the staging tip; each must report no change.

**Trigger surface:** Fixing a red release suite forward (kortix-release Step 4): a cherry-pick onto `staging`, or a dispatch with `ref=staging`.

**Incident:** 2026-11-02, release v0.14.15, two extra release-suite cycles (~40 min each). (1) The FILE-9 cherry-pick #11468 carried `dev`'s `MEMORY.md` hunk. It listed the 13:47 entry of #11463, which is on `dev` only. `core-db` failed `tests/unit/learnings-ledger.test.ts`. Fixed on staging by #11475. (2) #11435 used the billing key `storage` without regenerating `packages/ui/src/i18n/en.ts`. On `dev`, the unrelated #11464 regenerated the catalog and hid the gap. On `staging`, packages-rest failed `en.ts matches its sources`. Fixed on staging by #11473.

**Enforcement:** The release suite catches both (`tests/unit/learnings-ledger.test.ts` in core-db, `packages/ui/src/i18n/i18n.test.tsx` in packages-rest), but only after a ~40 min cycle. kortix-release Step 4 now lists the two generator commands. None yet before the dispatch: the enforcer to build is a `promote.yml` preflight for `ref=staging` that runs both generators in check mode.
