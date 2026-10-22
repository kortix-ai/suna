---
recorded: 2026-09-28T18:10:57Z
incident_date: 2026-09-28
---
# Check translation catalog key order before the commit exists; a red check on a pull request or on main does not stop a merge

**Rule:** A commit that stages `apps/web/translations/*.json` must keep the key
order of HEAD, or of MERGE_HEAD in a merge. Resolve a catalog conflict with the
merge driver (`git checkout -m <file>`) or by taking one side, never with a
program that parses and rewrites the file. An intentional reorder is committed
with `I18N_REORDER=1` and carries the trailer `I18n-Reorder: intentional`.

**Trigger surface:** Merging `main` into a long-lived branch that touches the
catalogs, resolving a catalog conflict, or scripting a catalog edit.

**Incident:** The second catalog scramble in 6 days. A branch merge of `main`
(2026-09-24) rebuilt all nine catalogs through an unordered key set: 461 objects
per catalog changed order. `i18n-catalogs.yml` failed on the pull request and
again on the push to `main`; the pull request merged anyway (#7337, 2026-09-28).
`starter-prompts.test.ts` then failed 9 of 9 locales and the `Tests` packages
lane stayed red on `main` for 3 consecutive runs. A post-merge or PR-level check
reports; it does not block. Also found: inside a git hook GIT_DIR is set, `git
rev-parse --show-toplevel` returned `apps/web`, and `check` read no base
catalog, so it passed any reorder.

**Enforcement:** `.githooks/pre-commit` runs `i18n-catalogs.mjs check
--base=HEAD [--base=MERGE_HEAD]` when a catalog is staged.
`i18n-catalogs.test.mjs` covers the hook environment (GIT_DIR set) and the
two-base merge rule. `i18n-catalogs.yml` on push to `main` still reports.
