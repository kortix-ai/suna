---
recorded: 2026-10-26T16:53:11Z
incident_date: 2026-10-23
---
# Size a per-item migration step by the rows it writes, never by the whole item, and log every deferral at WARN with its size

**Rule:** When a background step writes part of an item (some messages of a session), read and convert only that part plus the metadata it needs, so its memory grows with what it writes. A memory or size guard that defers work logs a WARN with the item id and the byte size on every deferral. Work that can never fit is its own count (`oversize`), never a `deferred` that retries forever.

**Trigger surface:** Writing or reviewing a leader worker, backfill or merge pass that holds an item in memory or starts a thread for it (`apps/api/src/projects/session-log-*.ts`, `lib/thread-memory.ts`), and any guard that answers "not now".

**Incident:** 2026-10-23 to 2026-10-26, prod v0.14.8 (#10827, #10837). The mirror merge read the whole session to write its missing messages. 6 missing messages in 3 sessions over the capture cap went to the conversion thread, and its memory guard (RSS + 12x the whole session's JSON) deferred them on every pass, logged at debug only. 30+ passes (~62 min of ticks every ~2 h) re-scanned ~33,650 sessions; `mergedMissing` never turned true, so the Release B1 gates stayed open and Release B waited. No user impact. Fix: the PR that adds this entry (a SQL skeleton places each message; only the missing rows are read in full; `oversize` and `deferred` WARN with session id and bytes). On a synthetic 118 MB session with a 1 MB memory limit, the merge took 2.0 s and +13 MB RSS.

**Enforcement:**

- `apps/api/src/__tests__/integration-session-log-merge.test.ts`, describe "the merge reads only the rows it writes": an over-cap session with no thread room merges exactly as the whole conversion; an oversize message is counted, warned and keeps `mergedMissing` false.
- `apps/api/src/__tests__/integration-session-log-backfill.test.ts`, "the memory guard": the deferral WARN names the session and its bytes.
- None yet for other workers: a lint or review check that a guard's "not now" branch logs above debug.
