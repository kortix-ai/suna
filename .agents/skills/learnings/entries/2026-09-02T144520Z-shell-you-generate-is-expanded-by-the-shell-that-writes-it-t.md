---
recorded: 2026-09-02T14:45:20Z
incident_date: 2026-09-02
commit: 47a0c6174a
---
# Shell you GENERATE is expanded by the shell that writes it — transfer it base64, and prove the secret landed in one file

**When:** emitting a shell snippet from a TS template literal
(`buildPreviewBootstrapScript`), from a Python string, or through
`docker exec sh -lc "..."` / a provider `exec` API. Anything containing `$1`,
`$(...)`, `"` or `\n` is interpreted by the OUTER shell (or by TS) before the
inner script ever exists.

**Two failures in one afternoon, same root cause.** (1) An inline credential
helper, `git config credential.helper "!f() { ...; echo "password=$(cat $F)"; }; f"`
— the nested double quotes collapse, the outer shell runs `$(cat $F)` at CONFIG
time, and git stores the literal token in `.git/config`. (2) The workaround for
(1), written with `printf %s "...\n..."` through a provider exec: `%s` does not
interpret `\n` so the helper became one line, `$1` expanded to empty (`[ "" = get ]`),
and `$(cat ...)` expanded again — inlining the token a second time.

**The rules:** (1) transfer generated scripts **base64-encoded**
(`echo <b64> | base64 -d > file`) — the repo's own `encodedFileCommand` already
does this; (2) a credential belongs in exactly ONE file, and the check is a
`grep` for the token pattern across the config AND the helper, not just the one
you were thinking about; (3) `bash -n` proves syntax, never semantics — both
broken versions passed it. Only running the snippet and grepping the result
caught either.

**The enforcer that works:** a test that WRITES a sentinel token, executes the
emitted snippet in a temp repo, and asserts the sentinel is absent from
`.git/config` while the helper still answers `get` with it
(`tests/unit/sandbox-preview.test.ts`). Text assertions on the generated script
passed happily while the token leaked.
