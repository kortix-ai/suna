# Sandbox /tmp maintenance

The API cleans `/tmp` inside running sandboxes and moves a RAM-backed `/tmp`
onto disk. Code: `apps/api/src/projects/sandbox-maintenance/`.

## Why it exists

Platinum's `pt-init` mounted `/tmp` as a tmpfs at 50% of RAM. A guest has no
swap, and a memory snapshot keeps the tmpfs across stop and start. Every byte
written to `/tmp` stays in RAM until the sandbox is deleted.

On 2026-09-24, 2 of 17 active 4 GiB prod sandboxes had `/tmp` full (1.96 GiB).
One held abandoned legacy-transfer uploads from 8 days earlier. The other held
agent virtualenvs. The daemon memory guard stopped their turns on every command.

Platinum PR #1255 gives new templates a size-capped disk `/tmp` with an hourly
sweeper. A running or resumed sandbox never re-runs `pt-init`. This runner
converges those sandboxes.

## What it does

The box reaper visits every running sandbox. For each one that is due, the API
runs `tmp-maintenance.sh` as root through the provider's exec channel:

1. Delete abandoned legacy-transfer uploads:
   `/tmp/kortix-legacy-*/*.transfer-*`, not written for 1 hour.
2. Delete files not read, written, or changed for 10 days.
3. `migrate` mode, Platinum only, idle OpenCode only: move a tmpfs `/tmp` onto
   the disk image `/var/lib/pt-tmp.ext4` (the same image and options as
   Platinum #1255). The script refuses (`migrate_blocker`) when a process
   listens on a socket under `/tmp` (`sockets`) or holds a lock on a file
   there (`locks`). Platinum's keepalive (`flock -n /tmp/pt-ka.lock pt-ka`) is
   restarted on the new `/tmp` instead.
4. Trim the least recently read files when `/tmp` is crowded. A tmpfs is judged
   against RAM: above 25%, down to 15%. A disk `/tmp` is judged against its own
   size: above 80%, down to 60%. Files used in the last hour are never deleted.

Cleanup steps need GNU findutils. Every Kortix image ships it. Without it the
script measures nothing and deletes nothing.

Cadence: at most once per hour per sandbox. A `SandboxMemoryGuard` turn end
triggers a run at once. A failed run waits 30 minutes. A new mode runs at once.

## Modes

`SANDBOX_TMP_MAINTENANCE` in the API environment, read per call:

| Mode | Effect |
|---|---|
| `off` | Nothing runs. |
| `report` (default) | Measures what the other modes would free. Changes nothing. |
| `clean` | Steps 1, 2, and 4. |
| `migrate` | Steps 1–4. |

The mode is not a secret, so a deployed environment sets it in the API task
definition: `KORTIX_ECS_ENV_OVERRIDES` in `.github/workflows/deploy-<env>.yml`.
The next deploy of that environment applies it. Mirror it in the dotenvx file:
`dotenvx set SANDBOX_TMP_MAINTENANCE clean -f apps/api/.env.staging`.

Development runs `migrate`. Staging and production run `report` until someone
changes them.

## Rollout

1. Run `report` in production for at least one day.
2. Read the numbers (queries below). Check for unexpected blockers or failures.
3. Set `clean`. Then set `migrate`.

## Read the results

Each sandbox keeps its last run in `session_sandboxes.metadata->'tmpMaintenance'`:
`state`, `mode`, `lastRunAt`, `failures`, `tmpFs`, `tmpFsAfter`,
`shmemBeforeKb`, `shmemAfterKb`, `partialsKb`, `agedKb`, `evictedKb`,
`migrated`, `migratedAt`, `migrateBlocker`, `error`.

```sql
-- What report mode found across running sandboxes.
SELECT metadata->'tmpMaintenance'->>'tmpFs' AS fs,
       count(*) AS boxes,
       sum((metadata->'tmpMaintenance'->>'partialsKb')::bigint) / 1024 AS partials_mb,
       sum((metadata->'tmpMaintenance'->>'evictedKb')::bigint) / 1024 AS evict_mb,
       count(*) FILTER (WHERE metadata->'tmpMaintenance'->>'migrateBlocker' IS NOT NULL) AS blocked
  FROM kortix.session_sandboxes
 WHERE status = 'active' AND metadata ? 'tmpMaintenance'
 GROUP BY 1;
```

A run that freed, would free, or migrated something, or that failed, writes one
audit event: `action = 'sandbox.tmp.maintenance'`, phase `reported`, `cleaned`,
`migrated`, or `failed`.

## Stop it

Set `SANDBOX_TMP_MAINTENANCE=off`. The next reaper pass does nothing. A
migrated sandbox keeps its disk `/tmp` until it cold-boots.
