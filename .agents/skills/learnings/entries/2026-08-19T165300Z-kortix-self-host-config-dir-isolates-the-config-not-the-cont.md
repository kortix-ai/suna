---
recorded: 2026-08-19T16:53:00Z
incident_date: 2026-08-19
commit: 12b035377e
---
# `KORTIX_SELF_HOST_CONFIG_DIR` isolates the config, NOT the containers

**When:** exercising `kortix self-host` locally on a machine that already runs a
self-host instance. Pointing `KORTIX_SELF_HOST_CONFIG_DIR` at a temp directory
looks like a sandbox — `init` writes a fresh `.env` + compose there and touches
nothing else. But `composeProject(instance)` derives the Docker Compose project
name from the INSTANCE NAME alone (`kortix-<instance>`), so any command that
reaches `docker compose` — `env set`, `start`, `update`, `configure` — applies
the temp config to the containers of the REAL instance of the same name.
`env set EMAIL_URL=…` against a temp dir recreated the live instance's
`kortix-api` (×2, from the temp `KORTIX_APP_REPLICAS`) and `supabase-auth` with
the temp instance's secrets.

The rule: when testing self-host CLI commands against a throwaway config dir,
**also pass `--instance <unique-name>`** — that is the only input that moves the
Compose project. Verify with `docker ps --filter name=kortix-<instance>` BEFORE
running anything that restarts services, and prefer `--no-start` plus reading
the rendered `.env`/`docker-compose.yml` when you only need to inspect
derivation.

Recovery: re-apply the real instance's own files —
`docker compose --project-name kortix-<instance> --env-file <real>/.env -f
<real>/docker-compose.yml up -d --no-build` — then prove identity by diffing a
secret from the real `.env` against `docker exec … printenv`, not by health
alone (a container started from foreign config is perfectly healthy).
*Incident:* 2026-08-19 near-miss during the EMAIL_URL work — the local
`kortix-default` instance (16 containers, up 16 h) had 3 containers recreated
with a temp instance's secrets; restored in ~4 min, all 16 healthy after.
*Enforcer:* none — the CLI should either namespace the Compose project by the
config dir or refuse when the resolved project already exists under a different
instance directory. Until then this rule is the only guard.
