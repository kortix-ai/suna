---
title: Stateless sessions — a session is its workspace and its transcript, on its volume; the sandbox is disposable
status: target decided (Marko, 2026-11-02); stage 1 on dev (#11503, 18d18d0a05); the rest not started
owner: Marko (decision); next owner picks it up from this page
updated: 2026-11-02
---

# Stateless sessions

## The target (Marko, 2026-11-02)

**A session has exactly two stateful things: its workspace (the files) and
its transcript. Both live on the session's volume. The sandbox holds nothing
of its own.**

1. **Every session is stateless. No exceptions, no second path.**
   - Every session's `/workspace` is a Platinum volume, mounted into its
     sandbox at create.
   - A sandbox is destroyed when it stops.
   - A reopen creates a new sandbox and mounts the same volume.
   - A sandbox never comes back from its own disk.
2. **The transcript is a file on that volume, and it is the one source of
   truth.**
   - pi loads from it and writes to it.
   - The Kortix API reads the conversation from it: the session page, shares,
     search, MCP `read_session`.
   - No second copy is kept in sync. No rebuild from a database.
3. **Where the volume lives is open.**
   - It can stay one volume per session (`kws-<session_id>`).
   - It can fold into the project's one Drive volume, e.g. `/Sessions/<id>/`
     holding `workspace/` and `transcript.jsonl`.
   - Either way the session sees the same two things.

Everything below is how to get there from today. When a detail here conflicts
with the target, the target wins.

## Where we stand (2026-11-02)

| | Today | Target |
|---|---|---|
| `/workspace` of most sessions | **On the sandbox's own disk** (flag `workspace_volume` off). 84 % of prod sessions in the last 7 days. A reopen starts the same sandbox again. Platinum backs the disk up about every 60 min and archives it after 7 days stopped. | On the session's volume |
| `/workspace` with the flag on | On volume `kws-<session_id>` (`sync_mode: git`, one writer). The sandbox is deleted 60 min after it stops; a reopen mounts the volume in a new sandbox. Used by 1 project on prod (16 % of sessions); Dimitrije switched it off on 2026-11-01 after volume trouble. | This path, for every session |
| Transcript, source of truth | **Postgres** (`session_logs`, `session_log_threads`, `session_log_messages`; texts over 256 kB and attachments in the `session-attachments` bucket). The box posts it (`…/log/journal`) after every turn, every 5 s during a turn, and at stop. | A file on the session's volume |
| Transcript inside the box | pi's store: one JSON file on the sandbox disk (`~/.local/state/kortix/pi/<session_id>.json`), rewritten per turn. A new sandbox rebuilds it from Postgres before pi starts (`harness/shared/session-log-boot.ts` → `POST …/log/restore`). | pi reads and appends the volume file |
| Who reads the transcript | The page, shares, MCP: Postgres, never the box | The volume file |

Shipped toward the target:
- **#11503** (`18d18d0a05`, on dev): a stateless session no longer fails when
  Platinum answers `409 volume_flushing` (the previous sandbox's last writes are
  still being saved). The create waits `retry_after` and retries for up to
  2 minutes. On prod, 33 sessions failed on it on 2026-11-01.

Nothing else is built.

## Why the volume, in numbers

Measured 2026-11-02:
- prod session sizes, read-only;
- the Postgres read on prod, read-only;
- the volume and the network on a dev Platinum sandbox (eu-west) against the
  dev API (us-east-2).

| Session size | Rebuild from Postgres today (est.) | Read from the volume (measured, cold) |
|---|---|---|
| p50, 16 messages, 124 kB | ≈ 0.9 s | 3 ms |
| p90, 194 messages, 0.9 MB | ≈ 1.3 s | 4 ms |
| p99, 4,861 messages, 9.4 MB | ≈ 2.8 s, plus the large texts | 23 ms |
| max, 13,994 messages, 25.7 MB | partial: over the 24 MiB restore cap | 38 ms |

- The Postgres read alone is 3 / 19 / 172 / 402 ms.
- The rest of the rebuild is network: 2 requests at 0.2–0.6 s each from
  eu-west, plus the transfer.
- A new sandbox mounting the volume started in 1.2 s.

## The work, in order

1. **Make the stateless path reliable enough to be the only one.** On prod
   2026-10-26 … 11-02, stateless sessions failed 18.4 % of the time (147 of
   798), stateful ones 1.2 % (50 of 4,106). The 147 break down as:
   - 94 "the sandbox provider could not start" (88 of them on 2026-11-01, the
     Files-folder outage, since fixed by Platinum #2412 and Kortix #11421);
   - 33 `volume_flushing` (fixed by #11503);
   - 20 "prompt delivery dead-lettered" (cause not yet known: look at these
     first).

   The volume side is Platinum's. Agree the bar with Dimitrije; proposed:
   stateless fail rate ≤ 2 × stateful for 72 h on every dev project and
   Kortix's own prod projects, no new `volume_*` failure cause.
2. **Put the transcript on the volume as a file, and point pi at it.**
   - pi's state folder is configurable: `KORTIX_PI_STATE_DIR`, and kortixd's
     `KORTIX_RUNTIME_STATE_DIR` holds `session-log-restore.json`.
   - Keep the file outside the checkout, so `git clean -fdx` cannot delete
     it. Proposed layout:
     - the volume at `/session`;
     - the checkout at `/session/workspace` (`KORTIX_WORKSPACE`);
     - `/workspace` as a link to it;
     - the transcript and kortixd state at `/session/state`.
   - Write it append-only (JSONL: one record per line), so a long session
     does not re-upload the whole file on every 5 s volume save.
3. **Make the volume file the one source of truth.**
   - The API reads the transcript from the volume (Platinum's file API works
     with no sandbox running) instead of from Postgres.
   - Then the journal to Postgres and the restore go away.

   Open questions to settle before this step:
   - reading a transcript while no sandbox runs: latency of the file API for
     the page;
   - search across sessions: an index built from the files, like the Drive
     search index (`kortix.drive_index_entries`);
   - shares and the 30-day purge, then account erasure: delete the volume;
   - the live stream during a turn comes from the sandbox anyway;
   - two sandboxes of one session writing at once: today the API's restore
     generation fences an old sandbox out; the volume needs its own fence
     (Platinum's `exclusive` mount, or a generation in the file).
4. **Make it the default and delete the other path.**
   - Every new session gets a volume; the flag stays only as an emergency
     off switch.
   - Delete the stateful path: resume-from-disk, the Postgres rebuild, the
     journal.
5. **Decide where session volumes live.** One per session, or folded into the
   project's one Drive volume under `/Sessions/<id>/`. The constraints of the
   Drive volume today:
   - it syncs in `drive` mode (newest whole file wins, live across sandboxes),
     which corrupts a git checkout;
   - it has one merge queue per volume;
   - it shares one 100 GiB budget with everyone's files.

   Folding in needs Platinum to support a per-folder sync mode or per-folder
   sub-volumes ("cells", `platinum/docs/internal/shared-fs-10k.md`). Until then,
   one volume per session, shown in the Drive tree as `/Sessions` (read-only).

## Daily comparison (prod, read-only)

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

Failure causes of stateless sessions (ids masked):

```sql
select left(regexp_replace(coalesce(error, '(none)'),
         '[0-9a-f]{8}-[0-9a-f-]{27}|sbx_[A-Za-z0-9]+|kws-[a-z0-9-]+|kd-[a-z0-9]+|vol_[A-Za-z0-9]+', '<id>', 'g'), 110) as cause,
       count(*)
from kortix.project_sessions
where created_at > now() - interval '7 days' and status = 'failed' and metadata ? 'workspace_volume'
group by 1 order by 2 desc;
```

## Files

- `apps/api/src/platform/services/workspace-volume.ts` — the create-time decision and the volume (flag `workspace_volume`, off switch `KORTIX_WORKSPACE_VOLUMES=off`).
- `apps/api/src/platform/providers/platinum.ts` — the create; `volumeFlushRetryMs` (#11503).
- `apps/api/src/projects/reaping/idle-volume-retire.ts` — deletes a stopped stateless sandbox.
- `apps/api/src/projects/session-open/resume-stopped-sandbox.ts` — the stateful reopen (to delete).
- `apps/sandbox/entrypoint.sh` — waits for `/workspace` to be a mountpoint when `KORTIX_WORKSPACE_VOLUME=1`.
- `apps/kortix-sandbox-agent-server/src/services/workspace-provider/` — fills `/workspace` on the first boot (Git or the S3 project snapshot).
- `apps/kortix-sandbox-agent-server/src/harness/pi/config.ts` — `piStateDir` (`KORTIX_PI_STATE_DIR`).
- `apps/kortix-sandbox-agent-server/src/harness/pi/runtime.ts` — pi's store (`piDumpPath`, `SessionManager.inMemory`).
- `apps/kortix-sandbox-agent-server/src/harness/shared/session-log-boot.ts`, `session-log-journal.ts`, `session-log-restore.ts` — the Postgres journal and rebuild (to delete in step 4).
- `apps/api/src/projects/session-log-read.ts`, `session-log-restore.ts` — the API's reads and restore from Postgres.
