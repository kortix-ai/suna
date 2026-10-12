---
recorded: 2026-10-09T14:15:45Z
incident_date: 2026-09-14
supersedes: 2026-09-14T232503Z-await-archive-parser-completion-before-extraction.md
---
# Await archive parser completion before extraction

**Rule:** When an archive is downloaded through parallel file and validation streams, await the parser's verdict before you create the extraction directory or launch `tar`. A file sink that finished does not mean the decompressor checked every header. The rule is unchanged; its enforcer moved.

**Trigger surface:** Editing `downloadAndExtractProjectSnapshot` in `apps/kortix-sandbox-agent-server/src/lib/project-snapshot/archive.ts` (moved there from the workspace S3 transport on 2026-10-09), or any other streamed archive extraction.

**Incident:** PR #7240's Linux package gate created a stage for a traversal archive: the guard and the extraction raced (2026-09-14, near-miss, caught before merge).

**Enforcement:** the real traversal-archive regression in `apps/kortix-sandbox-agent-server/src/__tests__/workspace-provider.test.ts` (renamed from `config-provider.test.ts`). It requires no stage and no extracted files on rejection.
