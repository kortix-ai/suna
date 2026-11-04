---
recorded: 2026-11-03T09:30:33Z
incident_date: 2026-11-03
---
# Distinguish search audit labels by their backing resource

**Rule:** Give distinct handlers distinct audit actions and titles. Use an alias only when routes represent the same operation.

**Trigger surface:** Adding Drive search beside Git repository file search.

**Incident:** Release v0.14.17 run 41604035973 failed both shared audit catalog uniqueness checks. Drive index search copied the repository search label despite different storage and access rules.

**Enforcement:** `packages/shared/src/audit-labels.test.ts` checks strict action/title uniqueness and round-trip lookup for both search routes.
