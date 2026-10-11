---
recorded: 2026-10-11T01:27:16Z
incident_date: 2026-10-11
---
# Edit a translation catalog key in place: never pop and re-add it, or the key-order guard fails on the merge push

**Rule:** When a script changes a key in `apps/web/translations/*.json`, rename it in place (rebuild the object in the same order). Never `pop` the old key and assign the new one: that moves it to the end and reorders the catalog. Before pushing, run `node apps/web/scripts/i18n-catalogs.mjs check --base=origin/dev`; `pnpm test` does not run it.

**Trigger surface:** A Python or Node script edits `hardcodedUi.i18nComplete` keys, for example when a title changes and its `text<sha>` key changes with it, or when dead keys are removed.

**Incident:** 2026-10-11, PR #9527 (Apps on the Fly model). A scripted edit replaced one audit-title key with pop-then-assign in all 9 catalogs. The local suite stayed green. The `i18n-catalogs` guard failed on the merge push to `dev`. The fix forward restored the order with `restore-order --from=<merge>^1`, committed with `I18N_REORDER=1` and the `I18n-Reorder: intentional` trailer. Blast radius: one red guard run on `dev`; no deploy was blocked.

**Enforcement:** `.github/workflows/i18n-catalogs.yml` (`check --base=HEAD^1`) on a push to `dev`. It runs after the merge, so it is too late: none yet before the merge. The enforcer to build is the same check in `.githooks/pre-push` or in the `packages` lane.
