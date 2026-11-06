---
recorded: 2026-11-05T12:45:43Z
incident_date: 2026-11-05
---
# Typecheck every package you edited after its last edit, a scripted string edit included, before you merge

**Rule:** Run the typecheck of every package you touched after the last edit to its files, and before the merge. A test run that imports a sibling module does not parse the file you changed; a `sed` or script edit to a string can break the parse with one quote.

**Trigger surface:** Editing a TypeScript file with `sed`, `python` or another script (an OpenAPI description, a prompt, a doc string inside code), late in a change, after the tests already ran.

**Incident:** 2026-11-05, #11825 (merged as `85e73c31c8`). A `sed` edit put `trigger's` inside a single-quoted OpenAPI description in `apps/api/src/projects/routes/runtime-triggers.ts`; the file no longer parsed (TS1005), so the API could not start from that commit. The unit tests ran against `lib/runtime-triggers.ts` and passed. Found 4 minutes after the merge by a later `kortix-api` typecheck; the queued dev deploy of that commit was superseded before it built, and the hotfix #11826 (`2e20165204`) shipped instead. Dev never served the broken commit.

**Enforcement:** none yet: a PR into `dev` runs no check (testing reset 2026-10-16) and the pre-commit hook does not parse changed TypeScript. The enforcer to build: a pre-commit step that runs `bun build --no-bundle` (parse only, milliseconds) on each staged `.ts`/`.tsx` file under `apps/api` and `apps/kortix-sandbox-agent-server`.
