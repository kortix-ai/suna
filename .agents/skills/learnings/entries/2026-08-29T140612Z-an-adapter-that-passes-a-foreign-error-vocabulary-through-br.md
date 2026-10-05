---
recorded: 2026-08-29T14:06:12Z
incident_date: 2026-08-29
commit: 1d6e43c051
---
# An adapter that passes a foreign error vocabulary through breaks the consumer silently

**When:** bridging one runtime's filesystem/exec contract to another's over
HTTP (env-rpc, tool bridges, anything returning `{code, message}`).
The daemon's env-rpc is a thin `fs` proxy and returns the real errno; the
worker's `KortixExecutionEnv` handed it straight to pi as a `FileError.code`.
pi's `withFileMutationQueue` canonicalises a mutation target first and tolerates
a path that does not exist YET — but only for code `not_found`, rethrowing
anything else. So `ENOENT` meant **`write` could never create a file**: every
new file died on its own pre-flight lstat and the agent fell back to `bash`
heredocs (10 in one turn, live), while the tool's own description promised
"Creates the file if it doesn't exist".
**The rule:** translate at the adapter, mirror the reference implementation
verbatim (pi's `harness/env/nodejs.js`, its spellings `not_directory` /
`is_directory` included), and map unmapped errnos to `unknown` rather than
leaking a second raw code. A passthrough default is what hides this: the happy
path works, only the CREATE path fails.
*Incident:* pi.kortix.com, all file creation, until #7024.
*Enforcer:* `kortix-env.test.ts`.
