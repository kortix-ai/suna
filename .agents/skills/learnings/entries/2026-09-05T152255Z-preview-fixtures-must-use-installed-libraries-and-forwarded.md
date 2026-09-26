---
recorded: 2026-09-05T15:22:55Z
incident_date: 2026-09-04
commit: c83214363c
---
# Preview fixtures must use installed libraries and forwarded secrets

**When:** adding preview browser setup or a runtime secret allowlist. Use the shared `pg`
client with parameterized SQL. Do not spawn a host CLI that the test image does not install.
Build the runtime-secret object from the allowlist so an allowlisted workflow secret cannot be
silently omitted. *Incident:* PR #7109 target-full stopped at `spawnSync psql ENOENT`; managed
Git calls also returned `403` because `MANAGED_GIT_GITHUB_TOKEN` never entered the runtime
object. *Enforcers:* `preview-stack.test.ts` and the preview target-full browser census.
