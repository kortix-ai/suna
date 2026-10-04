# Fix-forward traps

Six failure shapes account for most of the "fix on `main`, re-promote" loop in
[SKILL.md](../SKILL.md) Step 4. Check these first before debugging a red check
from scratch.

## Out-of-order migration timestamps

`db-migrations.yml`'s `Migrations are sequential` job (`checkOrder`) compares
the ledger's run order (`ORDER BY run_on, id`) position-by-position against
filename order. A migration merged with a timestamp **older** than one already
applied on dev, staging, or prod fails every later `migrate` on that
environment — not just CI.

**Fix:** rename the offending file(s) so their timestamp sorts after the newest
migration already applied on the environment ahead of it (check
`kortix_migrations.pgmigrations`, not just the tree — a file existing in a
branch is not proof it ran). Keep relative order between the renamed files if
they depend on each other. Real incident: PR #8010 (2026-09-28) renamed two
GitHub-installation migrations that PR #7445 had merged with an older
timestamp than migrations already on dev; Deploy Dev had failed on every `main`
commit since. See `packages/db/MIGRATIONS.md` and the **migration** skill.

## Stale `mock.module` stubs after a refactor

Bun's `mock.module` replaces a module **wholesale** for every test file in the
same run. Adding an export, a query, or a call to a module that a suite mocks
makes that suite fail with "not a function" even though the real module is
correct — the stub is missing the new member. This is why the `packages` lane
is slow to trust from a diff alone: run it locally
(`pnpm test -- --packages-only`) before assuming the failure is a real
regression. Spread the real module into the stub
(`{ ...actual, theNewThing: mock(...) }`) rather than hand-listing every member.
See the **learnings** entries "A new import edge into a widely-mocked graph
breaks hand-written test doubles" (2026-08-27) and "Run the packages lane
before merging a change to a module that `mock.module` replaces" (2026-09-29).

## Source-anchor tests after a file move

Some tests assert a literal path — an import path, a generated-artifact path,
or a citation of a real file (`tests/unit/no-docs-tree.test.ts` is one
concrete example: it fails on any tracked file that still cites a path under
`docs/`). A refactor that moves or renames the anchored file breaks these
tests with no change to behavior. Before treating the failure as a logic bug,
diff the test's expected path against the current tree and update the
anchor, not the assertion's intent.

## Unintentional i18n catalog reordering

`i18n-catalogs` fails a release PR whose diff reorders keys in
`apps/web/translations/*.json` without the `i18n-reorder` label (on a release
PR) or `I18N_REORDER=1` past `.githooks/pre-commit` plus the `I18n-Reorder:
intentional` commit trailer (on `main`). Most reorders are an accidental
side effect of a formatter or a merge, not intended — fix the diff so keys keep
their order instead of reaching for the label. Add the label only when the
reorder is deliberate and you can point to the PR that intended it. See the
**contributing** skill, "Labels" table.

## A stale `learnings/MEMORY.md`

`MEMORY.md` is generated from `entries/` by `scripts/index.sh` and must never
be hand-edited. A promotion that adds or touches a learnings entry without
regenerating the index fails `bash .agents/skills/learnings/scripts/index.sh
--check` on the staging PR. Run `scripts/index.sh` (no flag) and commit the
regenerated file alongside the entry.

## A CodeQL alert in old code, surfaced by a large diff

CodeQL analyzes the whole changed file, not just the changed lines, so a
large or long-overdue diff can surface a finding in code the PR did not intend
to touch (real incident: PR #8159, "green main — config archive race
(CodeQL)", 2026-09-29 — a real stat-then-read race, fixed on `main`).
`staging`'s branch protection requires every review conversation resolved
(`required_conversation_resolution: true`), so an unresolved CodeQL thread
blocks the merge button regardless of which path below applies.

Two outcomes, never a third:

- **A real finding** — fix the underlying issue on `main` like any other red
  check (PR #8159). Never silence it with a suppression comment, a config
  exclusion, or a weakened query to unblock a promotion.
- **A proven false positive** — dismiss it on GitHub with a written
  justification that cites the concrete spec or constraint that makes the
  flagged code correct, then re-run the check:

  ```bash
  gh api -X PATCH repos/kortix-ai/suna/code-scanning/alerts/<n> \
    -f state=dismissed -f dismissed_reason="false positive" \
    -f dismissed_comment="<spec/evidence>"
  ```

  Real example: alert 6965, `js/weak-cryptographic-algorithm` on
  `apps/api/src/services/connectors/call.ts:318` — OAuth 1.0a (RFC 5849 §3.4.2)
  mandates HMAC-SHA1 as the signature method, and HMAC-SHA1 is not broken as a
  MAC (the break is in SHA-1 as a collision-resistant hash, which does not
  apply to its use as a MAC); changing the algorithm would break every OAuth1
  connector. **Never dismiss an alert without that evidence in the comment** —
  "flaky" or "not a priority" is not a justification and leaves the thread
  unresolved in spirit even if GitHub shows it closed.
