---
recorded: 2026-09-25T17:11:26Z
incident_date: 2026-09-21
commit: cd6b6ab7af
---
# Never pipe one Bun child process into another for binary output

**Near miss.** Building a 4 MiB config archive as `git archive` piped into
`gzip -n`, both spawned from Bun, produced 982,058 bytes. Both processes exited
0. Nothing reported the truncation. Found in the config-releases API lane before
it shipped. `materializeRepoContext` already avoids the same failure class.

**Rule.** For binary output between two child processes, write the first to a
file (`git archive -o <file>`), then read the file with the second. Never trust
exit codes alone for a pipeline: check the byte count or a digest at the end.

**Enforcement.** `apps/api/src/config-releases/builder.test.ts` builds an archive
larger than the truncation point and asserts it is complete and byte-identical
across two builds.
