---
recorded: 2026-09-14T23:25:03Z
incident_date: 2026-09-14
commit: 393d4e5fc5
---
# Await archive parser completion before extraction

**When:** downloading an archive through parallel file and validation streams.
A file sink finishing does not mean the decompressor has checked every header.
Await the parser verdict before creating the extraction directory or launching tar.
*Near-miss:* PR #7240 Linux package gate created a stage for a traversal archive;
the guard and extraction raced. *Enforcer:* real traversal archive regression in
`config-provider.test.ts`; it requires no stage and no extracted files on rejection.
