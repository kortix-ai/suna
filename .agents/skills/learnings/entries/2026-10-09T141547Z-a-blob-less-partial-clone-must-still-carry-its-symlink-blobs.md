---
recorded: 2026-10-09T14:15:47Z
incident_date: 2026-09-13
supersedes: 2026-09-14T201014Z-a-blob-less-partial-clone-must-still-carry-its-symlink-blobs.md
---
# A blob-less partial clone must still carry its symlink blobs, and a small fetch is loose objects, not a pack

**Rule:** (1) Ship symlink blobs with the trees of a blob-less checkout: `git status` and `update-index --refresh` compare a symlink against its blob's content, so a missing symlink blob lazy-fetches through the promisor remote on every status. (2) A `git fetch` below `transfer.unpackLimit` (100 objects) writes loose objects, not a pack: fetch with `-c transfer.unpackLimit=1` and purge `objects/??/`. The rule is unchanged; its daemon enforcer moved.

**Trigger surface:** Building or consuming a blob-less checkout: the project snapshot v2 (`apps/kortix-sandbox-agent-server/src/lib/project-snapshot/`, the API's snapshot builder) or any `--filter=blob:none` scheme.

**Incident:** 2026-09-13, both caught before merge by the daemon suite (a status timeout) and the integration suite (0 missing objects where blobs were expected).

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/workspace-provider.test.ts` (renamed from `config-provider.test.ts`; symlinked fixture, `--missing=print` counts) and `integration-project-snapshot.test.ts` (distinct-blob count).
