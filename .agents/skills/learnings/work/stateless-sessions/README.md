---
title: Stateless sessions — every session's /workspace and conversation on its own volume
status: in progress (branch `stateless-sessions`), stage 1
owner: Marko (decision), Dimitrije (Platinum volume stability), session agent (Kortix side)
updated: 2026-11-02
---

# Stateless sessions

## The problem

Two systems run side by side, and the stateless one carries almost no traffic.

| Path | How `/workspace` is kept | On a reopen |
|---|---|---|
| Stateful (flag `workspace_volume` off) | A folder on the sandbox's own root disk. Platinum backs the disk up about every 60 min (one copy) and archives it after 7 days stopped. | The same sandbox starts again (`session-open/resume-stopped-sandbox.ts`). A lost sandbox loses up to ~90 min of writes; a new box restores only the pushed session branch. |
| Stateless (flag on) | Platinum volume `kws-<session_id>`, `sync_mode: git` (one writer), saved every 5 s. | A box stopped 60 min is deleted (`reaping/idle-volume-retire.ts`); the next open boots a new box on the same volume. |

The conversation lives in Postgres (`session_log*`, large texts in the
`session-attachments` bucket). A new box rebuilds pi's store from it before the
agent starts (`harness/shared/session-log-boot.ts` → `POST …/log/restore`).

## Decided (Marko, 2026-11-02)

Stateless for every session, in stages, with exit numbers. The flag stays as
the off switch. Then delete the stateful path. Then `/Sessions` in the Drive.

## Stages

1. **Retry `volume_flushing`** instead of failing the session (this branch).
   Daily comparison query below.
2. **pi's session JSONL on the volume** (`/workspace/.kortix/session.jsonl`,
   pi's header plus one entry per line), written as the conversation goes. A new
   box reads it; the Postgres rebuild stays the fallback. Postgres keeps
   receiving the log as today.
3. **72 h soak**: flag on for every dev project and Kortix's own prod projects.
   Go on only if all hold:
   - stateless fail rate ≤ 2 × stateful (stateful was 1.2 % on prod, 2026-10-26 … 11-02);
   - no new `volume_*` failure cause;
   - reopen faster than today (measured on dev, before and after stage 2).
4. **Default on** for every new session; the flag (per project) and
   `KORTIX_WORKSPACE_VOLUMES=off` (global) stay as the off switch.
5. **Delete the stateful path** 2 weeks after stage 4.
6. **`/Sessions` in the Drive**: a read-only view of each session's volume and
   `log.jsonl`, visible to people who may open the session.

## Measurements so far (2026-11-02)

Prod sessions created 2026-10-26 … 11-02:

| | Sessions | Failed |
|---|---|---|
| Stateful | 4,106 | 50 (1.2 %) |
| Stateless (one project) | 798 | 147 (18.4 %); 46 of 491 (9.4 %) on 10-30 and 10-31 |

The 147 stateless failures: 94 "the sandbox provider could not start" (88 of
them on 2026-11-01, the Files-folder outage, since fixed by Platinum #2412 and
Kortix #11421); 33 `409 volume_flushing` that Kortix did not retry (stage 1);
20 "prompt delivery dead-lettered" (cause not yet known).

Conversation rebuild vs. read from the volume (prod sizes; Postgres read on
prod, read-only; volume and network on a dev Platinum box in eu-west against
the dev API in us-east-2):

| Session size | Postgres read | Network | From Postgres (est.) | From the volume (measured, cold) |
|---|---|---|---|---|
| p50, 16 messages, 124 kB | 3 ms | ~0.1 s | ≈ 0.9 s | 3 ms |
| p90, 194 messages, 0.9 MB | 19 ms | ~0.5 s | ≈ 1.3 s | 4 ms |
| p99, 4,861 messages, 9.4 MB | 172 ms | 1.8 s | ≈ 2.8 s + large texts | 23 ms |
| max, 13,994 messages, 25.7 MB | 402 ms | 4.0 s | partial (24 MiB cap) | 38 ms |

The estimate adds the restore's two round trips (manifest, restore) at 0.2–0.6 s
each from eu-west. A new box mounting the volume started in 1.2 s.

## The daily comparison

Read-only, against the prod database:

```sql
select date(created_at) as day,
       case when metadata ? 'workspace_volume' then 'stateless' else 'stateful' end as path,
       count(*) filter (where status = 'failed') as failed,
       count(*) as sessions,
       round(100.0 * count(*) filter (where status = 'failed') / count(*), 1) as failed_pct
from kortix.project_sessions
where created_at > now() - interval '7 days'
group by 1, 2 order by 1, 2;
```

Failure causes of stateless sessions (`error` column, ids masked):

```sql
select left(regexp_replace(coalesce(error, '(none)'),
         '[0-9a-f]{8}-[0-9a-f-]{27}|sbx_[A-Za-z0-9]+|kws-[a-z0-9-]+|kd-[a-z0-9]+|vol_[A-Za-z0-9]+', '<id>', 'g'), 110) as cause,
       count(*)
from kortix.project_sessions
where created_at > now() - interval '7 days' and status = 'failed' and metadata ? 'workspace_volume'
group by 1 order by 2 desc;
```

## Files

- `apps/api/src/platform/services/workspace-volume.ts` — the create-time decision, the volume.
- `apps/api/src/platform/providers/platinum.ts` — the create; `volumeFlushRetryMs` (stage 1).
- `apps/api/src/projects/reaping/idle-volume-retire.ts` — deletes a stopped stateless box.
- `apps/kortix-sandbox-agent-server/src/services/workspace-provider/` — fills `/workspace`.
- `apps/kortix-sandbox-agent-server/src/harness/shared/session-log-boot.ts`, `session-log-restore.ts` — the conversation rebuild.
- `apps/kortix-sandbox-agent-server/src/harness/pi/runtime.ts` — pi's store (`piDumpPath`, `SessionManager.inMemory`).
