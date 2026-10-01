---
recorded: 2026-09-30T23:47:27Z
incident_date: 2026-10-01
---
# Never put a top-level await in an imported apps/api module

**Rule:** A module that other `apps/api` code imports must not `await` at top level, including inside an `if (import.meta.main) { … }` block. Put a runnable entry point in its own file under `apps/api/scripts/` (or `src/scripts/`), which nothing imports.

**Trigger surface:** Adding a "run me with bun to regenerate X" block to a library module, or any `const x = await …` at module scope in `apps/api/src`.

**Incident:** 2026-10-01, caught before merge. The live Codex lineup branch added `if (import.meta.main) { await fetch(…) }` to `llm-gateway/models/codex-models.ts`, a module that `secrets/provider-key-selection.ts` also imports. The top-level await made the module async and reordered module evaluation. An anonymous `POST /v1/projects/:id/turn-permission` then reached the handler and returned 403 instead of the auth middleware's 401 (flow PROJ-38: 5 of 5 runs failed; `main` passed 3 of 3). A file-group bisect isolated `codex-models.ts`, and removing only the block restored 401. The regeneration moved to `apps/api/scripts/refresh-codex-seed.ts`.

**Enforcement:** `apps/api/src/__tests__/unit-no-top-level-await.test.ts` fails on any top-level `await` in a non-entry module under `apps/api/src`.
