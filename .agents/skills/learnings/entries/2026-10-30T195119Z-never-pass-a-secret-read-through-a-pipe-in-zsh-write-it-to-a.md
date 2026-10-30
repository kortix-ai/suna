---
recorded: 2026-10-30T19:51:19Z
incident_date: 2026-10-30
---
# Never pass a secret read through a pipe in zsh; write it to a file

**Rule:** Read a secret into a file with a plain `> file` redirect (mode 600), never through a pipe. In zsh, `cmd >/dev/null | head` still sends stdout into the pipe: the `MULTIOS` option, on by default, copies an output redirected to a file AND a pipe to both. To see only a command's error, run `cmd >/dev/null 2>err.txt` and read `err.txt`. Agent shells run zsh, so a redirect that is safe in bash is not safe there.

**Trigger surface:** Reading AWS Secrets Manager blobs (`kortix-ci-env`, `kortix-*-env`), `dotenvx get`, or any command whose stdout is a credential, from an agent session or a terminal on zsh.

**Incident:** 2026-10-30, an agent session preparing a mobile store build. To see why a secret read failed, it ran `aws secretsmanager get-secret-value … 2>&1 >/dev/null | head` under zsh. `MULTIOS` sent the whole `kortix-ci-env` blob (every CI credential) into the pipe and the session transcript. Nothing reached git or a PR. The credentials in that blob are treated as exposed and need rotation.

**Enforcement:** none yet: an agent `PreToolUse` hook that refuses a `secretsmanager get-secret-value`, `dotenvx get` or `--query SecretString` command whose stdout goes to a pipe.
