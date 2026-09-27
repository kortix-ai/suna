---
recorded: 2026-09-26T15:55:02Z
incident_date: 2026-09-15
---
# Promote the staging commit that build-staging actually built, never a moving tip or a `[skip ci]` VERSION bump

**Rule:** `promote.yml` pins `RELEASE_SOURCE_SHA` to `staging` HEAD, and
`deploy-prod` RETAGS `staging-<sha8>` images — it never rebuilds. `staging`'s
HEAD can be a `chore(release): staging VERSION → X.Y.Z [skip ci]` commit that
`build-staging.yml` never ran for, because that commit lands automatically at
the end of every prod deploy and can land on top of a merge that already built.
Before promoting, compare `git rev-parse origin/staging` against the SHA
`build-staging`/`deploy-staging` actually built
(`gh run list --workflow build-staging.yml --branch staging --json headSha`).
If they differ, either dispatch `build-staging.yml -f sha=<sha>` and wait, or
pass `-f ref=<the built SHA>` to `promote.yml` — the tree differs from HEAD
only by the VERSION file, which promote stamps anyway.

**Trigger surface:** any promote to production, especially two releases cut in
one sitting or any time `staging` moved after the previous release.

**Incident:** v0.13.16/v0.13.18 (2026-09-15), two separate occurrences of the
same class. `sync-staging-version` squash-merged a VERSION bump onto `staging`
after a fresh `main → staging` merge had already built and gone untested; a
promote of the tip would have opened a release PR whose `RELEASE_SOURCE_SHA`
had no image, refused only after the release gate had run for an hour. Caught
before promoting each time; no prod impact.

**Enforcement:** none yet — `promote.yml` should refuse (or walk back to the
nearest built ancestor) when `IMAGE_SHA` has no green `build-staging` run. That
check is the TODO.
