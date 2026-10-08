---
recorded: 2026-10-06T12:05:46Z
incident_date: 2026-10-04
---
# Pin one version of every instanceof-checked singleton, so a lockfile re-resolve cannot split it

**Rule:** A package that checks its own objects with `instanceof` must resolve to exactly one version in `pnpm-lock.yaml`. Pin it in the root `pnpm.overrides` and guard it with a lockfile test. Today: `@codemirror/state`, `@codemirror/view`, `@lezer/common`. Before merging any PR that changes `pnpm-lock.yaml`, including a Dependabot bump of an unrelated package, read the lockfile diff for new duplicate versions.

**Trigger surface:** merging a dependency bump or any PR that re-resolves `pnpm-lock.yaml`; adding a library that needs a single instance (CodeMirror, ProseMirror, React, Yjs).

**Incident:** 2026-10-04. #8563 (Dependabot `hono` 4.13.5 → 4.13.7, merged with no review) re-resolved the lockfile into two copies of `@codemirror/state` (6.7.5 + 6.7.6), `@codemirror/view` and `@lezer/common`. Every code-editor preview (yaml, json, …) on dev and prod showed "Couldn't preview this file". Shipped to prod in v0.13.50. Better Stack logged 200+ `Unrecognized extension value in extension set` errors before #9217 pinned the versions.

**Enforcement:** `tests/unit/codemirror-single-instance.test.ts` fails when the lockfile holds more than one version of any pinned singleton. It runs in `pnpm test`.
