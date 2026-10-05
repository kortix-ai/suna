---
recorded: 2026-09-01T18:29:20Z
incident_date: 2026-09-01
commit: 183bed483c
---
# Two repairs for the same deploy race each other, and the loser's fix is silently undone

**When:** any environment where a deploy REGENERATES config and more than one
actor patches it back. On pi.kortix.com the deploy rewrites
`docker-compose.preview.yml` from main's `tests/`, dropping the `kortix-api`
git-cache volume. Two things restore state afterwards: `post-deploy.sh` (runs
when the deploy run reports success) and the in-sandbox managed-git guard (runs
150 s after it sees the token wiped). Both call the same
`docker compose … up -d --force-recreate --no-deps kortix-api`. Whichever runs
LAST decides the outcome — and the guard recreated against the still-stripped
overlay at 18:19:43, giving the API an unmounted `/tmp/kortix`. Every project's
git mirror, including pi-lab's bare upstream, disappeared from the container's
view and `POST /projects/:id/sessions` answered **500 GitOperationError: '…/pi-lab.git'
does not appear to be a git repository**. The data was never lost — the volume
still held all 67 refs; only the mount was missing.
**Rules:** (1) every actor that recreates a container must ASSERT the full
desired config first, not assume a sibling script already did — the guard now
re-appends the volume block before its own recreate; (2) a repair script is not
a substitute for the config reaching `main`; (3) when a deploy regenerates
config, enumerate everything that recreates containers on that box before
declaring the environment fixed.
**Diagnostic:** `docker inspect <api> --format '{{range .Mounts}}…'` returning
EMPTY while `docker compose … config` shows the volume correctly — that gap means
the RUNNING container predates the config, so read the container's `Created`
timestamp against the repair logs.
*Incident:* pi.kortix.com session-create broken ~18:19–18:26 UTC, found by a
verification turn rather than by an alarm. No user traffic.
*Enforcer:* the guard's own assertion (in-sandbox). The real fix is landing
`tests/` on main so nothing has to be re-applied at all.
