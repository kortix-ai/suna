---
recorded: 2026-08-27T20:17:12Z
commit: c917b9fe5f
---
# Deployed configuration has one truth, and it is not the file in git

Found 2026-08-27 while auditing secret access. The git profiles
`apps/api/.env.{dev,staging,prod}` had drifted far from what the deployed
environments actually run: dev was missing 54 keys, staging 34, prod 90, and
`.env.prod` still declared `FRONTEND_URL=http://localhost:3000`. Runtime truth
is the AWS Secrets Manager blob `kortix-<env>-env`, injected by ECS as
`KORTIX_ENV_JSON`, plus the plain `environment` entries on the API task
definition. Nothing synchronized the two: the dev and prod blobs are edited by
operators, and the staging blob is rebuilt as existing-blob-plus-overrides on
each staging deploy. An operator reading the git file was reading fiction.

**Rules.**
1. Name the single runtime source for every deployed setting, and make a
   committed check assert the file equals it. Drift that nothing measures grows
   without bound.
2. Pull from the runtime source into the file. Push a file value into the
   runtime source only as a deliberate change with a rollout.
3. A file that mirrors a deployed environment must not receive a credential
   whose value is identical to production, when that file is readable by more
   people than production is. Keep it in the secret store and record the
   omission with its reason.
4. Every tool that reads or writes a dotenvx file must run the CLI with a bare
   environment. An exported shell variable makes `dotenvx get` return the shell
   value and `dotenvx set` a silent no-op that reports `○ no change`, so a
   comparison silently reads — and a write silently skips — the wrong value.
5. dotenvx writes `KEY="encrypted:…"` with quotes. A plaintext scan that matches
   `=encrypted:` reports every encrypted value as plaintext. Match
   `=["']?encrypted:`.
6. Verify a credential before treating it as sensitive. The three
   `AWS_SECRET_ACCESS_KEY` values in these files returned
   `SignatureDoesNotMatch`; they were dead keys, not live production access.

*Automation:* `pnpm test:envs --sm` runs `scripts/secrets-sm-parity.py check`,
which fails on any Secrets Manager or task-definition key that is missing or
different in the file. `scripts/secrets-file-only.allowlist` and
`scripts/secrets-sm-quarantine.allowlist` carry the two classes of deliberate
exception, each line with the rotation that removes it.

*Incident:* no outage. The audit found the drift; no deployed environment was
changed.
