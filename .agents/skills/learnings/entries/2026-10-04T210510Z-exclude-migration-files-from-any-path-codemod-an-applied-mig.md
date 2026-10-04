---
recorded: 2026-10-04T21:05:10Z
incident_date: 2026-10-04
---
# Exclude migration files from any path codemod: an applied migration is checksummed byte for byte

**Rule:** A codemod that rewrites file paths repo-wide (moves, renames, citation updates) must skip `packages/db/migrations/**`. Never edit an applied migration, not even a comment: node-pg-migrate stores each file's checksum and refuses a changed one on every database that already ran it.

**Trigger surface:** Moving or renaming files under `apps/api/src` (or any package) with a script that also rewrites `apps/api/src/<path>` citations in comments across the repository. Migration SQL often cites the code that reads its tables.

**Incident:** 2026-10-04, near-miss on the R4 API layers branch, before any push. The citation pass rewrote comments in 27 migration files. The local `db-suites` lane failed at template creation with `20260819160100000_rbac_cutover_views.sql checksum mismatch`. Merged, it would have halted Deploy Dev at the migration step and every later deploy until reverted.

**Enforcement:** node-pg-migrate's checksum check, reached by the `db-suites` lane of `pnpm test` (it migrates a template database from the files) and by every deploy's migration step. Run `pnpm test` before opening a move PR. The same pass also edited sandbox-side sources (`apps/kortix-sandbox-agent-server`, `apps/sandbox`, `apps/kortix-worker`), whose content feeds the sandbox runtime fingerprint: exclude those from citation-only edits too, or every provider rebuilds its image on deploy.
