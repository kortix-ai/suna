---
recorded: 2026-08-31T13:21:58Z
commit: 95f60297b0
---
# An explicit pathspec does not isolate concurrent agents — it commits file STATE, not your hunks

- **Incident (2026-08-31, `identity-boundary`):** three implementer agents ran
  in parallel in ONE worktree on verified-disjoint file sets, each instructed to
  commit only its own pathspec. One task's whole job was retiring a bare
  `['accounts']` query key across ~39 call sites, and
  `app/(app)/projects/start/page.tsx` was both on that list and owned by another
  task. The second agent's `git commit -- <its files>` captured the first
  agent's in-flight `useAccountsList` refactor of that shared file. HEAD stayed
  self-consistent only because the other agent later committed the module its
  import needed — but for three commits the branch **did not build**, and a
  commit whose subject says "scope the suppress-auto-project check" contains an
  unrelated key migration. Its `git log`-based reference count also came out
  wrong (43 vs 42), because it measured a worktree another agent was mutating.
- **Rule:** `git commit -- <path>` records that path's CURRENT CONTENT, not the
  hunks you authored, so it is not isolation. Before running implementers in
  parallel on one worktree, compute disjointness against **every task still
  capable of writing — including ones not yet dispatched** — and never run a
  task with a wide call-site surface (a key/API/rename migration) concurrently
  with anything. Otherwise give each agent its own worktree, or serialize. What
  saved this one was luck: both agents completed. Had the migration reported
  BLOCKED — which its brief explicitly invited — half a cutover would have been
  stranded inside another task's commit.
- **Enforcement:** none. A pre-commit check that refuses when a staged path
  carries unstaged changes from another process, or a `pnpm worktree` guard that
  refuses a second concurrent writer, is the TODO. Until then this rule is the
  only guard, alongside the existing `git stash` and shared-worktree entries.
