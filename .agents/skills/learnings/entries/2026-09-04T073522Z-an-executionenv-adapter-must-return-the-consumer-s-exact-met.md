---
recorded: 2026-09-04T07:35:22Z
incident_date: 2026-09-04
commit: 77681271d3
---
# An ExecutionEnv adapter must return the consumer's exact metadata shape

**When:** bridging Pi filesystem operations to another process or runtime.
**Incident:** env-rpc returned `{isFile,modifiedAt}` while Pi requires `{name,path,kind,mtimeMs}`;
the real `edit` tool stopped after `fileInfo` and never read or wrote the target file.
**Rule:** mirror Pi's contract, use `lstat` to preserve symlinks, and test through the real tool.
**Enforcer:** `env-rpc-worker-integration.test.ts` runs scripted `edit` across worker and daemon.
