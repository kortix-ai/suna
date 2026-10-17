---
recorded: 2026-10-16T19:44:31Z
incident_date: 2026-10-16
---
# Gate every new manifest key on kortix_version, and prove a schema change with a prod-vs-dev differential compile

**Rule:** A key added to the manifest schema for one `kortix_version` must be gated on that version in every shared path (the import merge, the validator, the compiler). Before a promote, run every project class through `buildConfigRelease` on the prod tree and on dev, and diff the compiled governance.

**Trigger surface:** Editing `packages/manifest-schema` (`imports.ts`, `index.v2.ts`, `index.v3.ts`) or `apps/api/src/projects/lib/compile-agent-config.ts`; planning a dev → prod promote.

**Incident:** 2026-10-16, near-miss before the 0.13.58 promote. #10000 added `skills`, `commands` and `extensions` to `IMPORTABLE_MAP_KEYS` for v3, and the import merge applied them to v2 too. A v2 manifest with `imports:` and a non-map top-level `skills` failed with "`skills` must be a map"; compiled governance went to null and a real dev session fell back to `image-default` ("the default agent is not loaded"). 0.13.57 compiled the same manifest. Fixed in #10087 before prod.

**Enforcement:** `packages/manifest-schema/src/__tests__/imports.test.ts` "a v2 root keeps skills, commands and extensions out of the import merge". The prod-vs-dev differential compile is manual (none yet: a release-gate lane that compiles a fixture per project class on both trees).
