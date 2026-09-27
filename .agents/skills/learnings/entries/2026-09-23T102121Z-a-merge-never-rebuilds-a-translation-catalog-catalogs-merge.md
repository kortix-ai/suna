---
recorded: 2026-09-23T10:21:21Z
incident_date: 2026-09-23
commit: c4294a5f26
---
# A merge never rebuilds a translation catalog: catalogs merge key by key and keep their key order

**Rule:** Resolve a conflict in `apps/web/translations/*.json` with the catalog
merge driver (`pnpm install`, then `git checkout -m <file>`), never with a
program that parses both sides and writes the file back. A merge may add and
delete catalog keys; it never moves one. **Incident:** the last `origin/main`
merge into PR #7507 (`aba5055432`, squashed to `main` as `ea09f2f6a8`) had 1
text conflict per catalog and rebuilt all 9 through an unordered key set: 473
of 840 objects per catalog changed order (~38,500 diff lines each), 4 deleted
keys came back, and `starter-prompts.test.ts` turned the packages lane red on
`main` (run 35833541707). **Enforcers:** the merge driver
(`apps/web/scripts/i18n-catalogs.mjs`, `.gitattributes`,
`scripts/register-merge-drivers.sh`), `i18n-catalogs.yml` on every pull request
that touches a catalog, and `i18n-catalogs.test.mjs` in the packages lane.
