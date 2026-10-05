---
recorded: 2026-09-14T20:10:14Z
incident_date: 2026-09-13
commit: ccd3f7596d
---
# A blob-less partial clone must still carry its symlink blobs, and a small fetch is loose objects, not a pack

**When:** building or consuming a blob-less checkout (snapshot v2, any
`--filter=blob:none` scheme). (1) `git status` / `update-index --refresh`
compare a SYMLINK against its blob's CONTENT (`ce_compare_link`), so a tree
with one symlink lazy-fetches through the promisor remote on every status —
ship symlink blobs with the trees. (2) `git fetch` below
`transfer.unpackLimit` (100 objects) explodes the pack into LOOSE objects;
"remove the fetched pack" then leaves every blob in the archive — fetch with
`-c transfer.unpackLimit=1` and purge `objects/??/`.
*Near-miss:* both caught pre-merge by the daemon suite (a status timeout) and
the integration suite (0 missing objects where blobs were expected).
*Enforcer:* `config-provider.test.ts` (symlinked fixture, `--missing=print`
counts) and `integration-project-snapshot.test.ts` (distinct-blob count).
