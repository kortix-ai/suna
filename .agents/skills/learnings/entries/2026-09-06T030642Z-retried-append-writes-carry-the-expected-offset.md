---
recorded: 2026-09-06T03:06:42Z
incident_date: 2026-09-04
commit: 3caec60726
---
# Retried append writes carry the expected offset

**When:** splitting one upload into several mutating requests. A timeout can
happen after the daemon writes a chunk but before the client receives its 200.
Blindly retrying that append duplicates the bytes and corrupts the file. **The
rule:** each append carries its expected file offset. The daemon accepts the
next offset, treats an exact already-written chunk as a replay, and rejects any
other offset with 409. *Enforcer:* `files-routes.test.ts` replays one chunk;
`client.test.ts` and `runtime-prompt-file.test.ts` assert every sent offset.
