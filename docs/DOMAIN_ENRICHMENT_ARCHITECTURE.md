# Domain Enrichment — Architecture

A user gives us a company's domain. We read that company's public website and
write a structured profile into the project's memory, so every agent in the
project starts already knowing what the company does, who works there, and what
it charges.

This document is how it works, why the load-bearing parts are the way they are,
and — at the end — how to tell what is wrong when a job does not move.

---

## 1. The shape of it

```
  Browser                      API process                      Postgres
 ─────────                   ───────────────                   ──────────
 create project ──POST /v1/projects/provision──► insert project row
   (+ domain)                                  └► INSERT enrichment_jobs ─► queued
                                                     (fire-and-forget)

 onboarding ────POST /v1/enrichment/domains───► INSERT enrichment_jobs ─► queued
 wizard                                            (or attach to in-flight)

                        ┌──────────────────────────────────────┐
                        │  LEADER replica only, every 5s tick  │
                        │                                      │
   claim ◄──────────────┤  UPDATE … SET status='running'       │
                        │  guard → discover → fetch → extract  │
                        │  → commit profile to the git repo    │
                        └──────────────────────────────────────┘
                                        │
                     .kortix/memory/enrichment/<domain>.md
                     .kortix/memory/MEMORY.md  (one index line)
```

Two things are worth internalising immediately, because almost every confusing
symptom traces back to one of them:

1. **Submitting and doing are completely decoupled.** The HTTP request only
   writes a row. Nothing in the request path crawls anything.
2. **Only one process in the deployment does the work.** Not "any replica" —
   exactly one, chosen by a lease.

---

## 2. Why a queue at all

The crawl-and-extract cycle takes 30 seconds to 3 minutes: dozens of HTTP
fetches to a third-party site, then an LLM call over ~60k tokens. The API has a
**global 25-second request deadline** (`middleware/request-deadline.ts`). Doing
this work inline is not slow, it is impossible.

So the request does the only part that must be synchronous — validate, resolve
tenancy, dedupe — and hands off a row. The user gets a job id immediately.

**There is no cron.** Nothing external schedules this: no Kubernetes CronJob, no
`croner` entry, no webhook, no external queue service. The drain is a
`setInterval` living inside the API process itself.

That choice is deliberate. This repo has **no Redis and no queue library** —
every asynchronous workflow (session lifecycle, provider transitions, Suna
migrations) is a Postgres table drained by an in-process loop. Enrichment follows
that existing pattern rather than introducing a second coordination model.

---

## 3. The tables

Three, all in the `kortix` schema.

### `enrichment_jobs` — the queue

Modelled directly on `session_lifecycle_commands`, the repo's existing durable
queue.

| Column | Why it exists |
|---|---|
| `status` | `queued → running → succeeded / failed / dead_lettered` |
| `attempts` | Retry budget counter |
| `available_at` | Backoff gate — a retry is invisible until this passes |
| `locked_by` / `locked_until` | Visibility lease, so two workers cannot both run one job |
| `idempotency_key` | `<project_id>:<domain>` |
| `error_code` | Typed failure, surfaced by the status endpoint |
| `result` | jsonb: `memoryPath`, `pagesFetched`, `cacheHit`, … |

Two indexes matter. `(status, available_at)` serves the due-scan. And a
**partial unique index** on `idempotency_key` limited to `status IN ('queued',
'running')` enforces one *live* job per project+domain, while letting terminal
rows accumulate as history — so a domain can be re-enriched later without a
unique-violation, but cannot be enriched twice at once.

> Two rows for the same domain is therefore **correct** when they belong to
> different projects. The key is scoped per project, because the crawl is shared
> but the memory write is not.

### `enrichment_profiles` — the cross-tenant cache

Keyed by domain, deliberately **not** scoped to a tenant: a company's public
website is the same page for everyone, so the first org to enrich a domain
spares every later one the crawl, the tokens and the wait. Freshness is judged at
read time against `KORTIX_ENRICHMENT_PROFILE_TTL_DAYS` (default 60), so changing
the TTL takes effect immediately rather than only for new rows.

### `enrichment_page_cache` — per-URL markdown

Saves re-fetching unchanged pages on re-enrichment, and doubles as the preserved
raw crawl when extraction fails — so a failed job can be re-run against captured
text instead of hitting the site again.

---

## 4. Who runs the worker (the part that surprises people)

The worker starts inside `startSingletonWorkers()` in `apps/api/src/index.ts`,
alongside the trigger scheduler, project maintenance and the provider-transition
resumer. That function is called **only when this process wins leader election**.

Leader election (`shared/leader-election.ts`) is a TTL lease row in
`kortix.worker_leader_lease`: 60-second TTL, renewed every 20 seconds. One
process holds `background-workers`; the rest serve HTTP and run no loops.

Two reasons this matters beyond scheduling:

- **Politeness.** Five replicas each crawling the same site five times is how you
  get blocked.
- **The rate limiter can be in-memory.** Because exactly one process runs
  enrichment, the process-local token bucket capping outbound Jina requests is
  effectively deployment-wide. There is no distributed limiter, and none is
  needed.

It also means the lease is **shared by everything pointed at that database**.
Two API processes on one Postgres — say a primary checkout and a worktree — are
two candidates for one lease. See §9.

---

## 5. A tick, precisely

Every 5 seconds (`KORTIX_ENRICHMENT_WORKER_INTERVAL_MS`), guarded against
re-entry so a slow tick never overlaps itself:

1. **Select candidates** — `status='queued' AND available_at <= now()` and the
   lease is free, *or* `status='running'` with a lapsed `locked_until` (a crashed
   worker's job, reclaimed).
2. **Claim each** with a conditional `UPDATE` guarded on the status just
   observed. If another worker won the race, the update matches zero rows and
   this worker moves on. No row is ever processed twice while leased.
3. **Run at most 2 concurrently**, each under a 5-minute `AbortSignal`.

---

## 6. The eight stages

Once a job is claimed:

| # | Stage | What it does |
|---|---|---|
| 1 | **SSRF guard** | Resolve DNS, reject private/loopback/link-local/CGNAT/reserved addresses, https-only. Applied to the origin *and every discovered URL*, immediately before each fetch. |
| 2 | **Cache check** | Fresh profile in `enrichment_profiles` and not `force` → skip to stage 8. |
| 3 | **Discovery** | `robots.txt`, then `sitemap.xml` if it lists real company pages; otherwise a depth-2, same-origin, ≤40-page crawl. Harvests JSON-LD, OpenGraph, meta. Page bodies are discarded. |
| 4 | **Filter** | Canonicalize, dedupe, drop assets/archives/docs/auth/legal, rank by signal, cap 40. |
| 5 | **Fetch** | Each URL through Jina Reader — concurrency 4, 15s each, one retry, failures skipped. Page cache consulted first. |
| 6 | **Consolidate** | Structured signals first (never trimmed), priority pages truncated per page, blog as titles+links, ~60k-token budget. |
| 7 | **Extract** | One LLM call, JSON-schema constrained, validated by Zod, up to 2 repair rounds feeding the errors back. |
| 8 | **Memory write** | Commit `.kortix/memory/enrichment/<domain>.md`, then one index line in `MEMORY.md`. |

Some notes on why these are the way they are:

**Discovery keeps no page bodies.** A sitemap is a better index than any crawl —
authoritative, complete, free of navigation noise — so it is tried first, but
only trusted if it surfaces a real company page beyond the homepage. Readable
content comes later from Jina Reader, which renders JavaScript that this
HTML-only pass cannot. Keeping bodies here would double memory for nothing.

**JSON-LD is treated as ground truth.** A site publishing a `schema.org`
Organization block is handing us its legal name, logo, founders and socials as
data. That is worth more per token than the prose around it, so it goes into the
prompt first and is labelled trusted.

**The model is untrusted.** Nothing it returns is stored until Zod accepts it.
`sources` is required and non-empty — a model that invents a company wholesale
tends to invent it without citations, so "where did this come from" is the
cheapest structural check against fabrication. A job that exhausts its repairs
fails as `extraction_failed` with the crawl preserved. A missing profile is
recoverable; a confidently wrong one in company memory is not.

**Memory write order is profile-then-index.** An interruption leaves an
unreferenced file — harmless, fixed by the next run — rather than an index
pointing at a file that does not exist. Both writes are idempotent, and commits
retry with a re-read because the underlying commit is compare-and-swap on the
branch tip with no retry of its own.

**A cache hit still writes memory.** The crawl and extraction are shared across
tenants; landing the profile in *this* project's repository is not.

---

## 7. Failure handling

Failures split by whether retrying could possibly help.

**Permanent** — recorded immediately, never retried:

| Code | Meaning |
|---|---|
| `invalid_domain` | Unparseable, private, or unresolvable |
| `blocked` | The site refused us (challenge page, 403, nothing readable) |
| `extraction_failed` | No schema-valid profile after the repair budget |

**Transient** — back to `queued` behind a backoff gate (1 min, then 5 min),
`dead_lettered` after 3 attempts:

| Code | Meaning |
|---|---|
| `internal_error` | Ours: a database error, an upstream 5xx, a bug |
| `timeout` | Exceeded the 5-minute budget. Retried **once**, then `failed`. |

`internal_error` exists specifically so a failure on our side is never reported
to the user as the site being slow, and never inherits `timeout`'s deliberately
short retry budget.

---

## 8. Configuration

| Variable | Default | Notes |
|---|---|---|
| `KORTIX_ENRICHMENT_WORKER_ENABLED` | `false` | **The feature is dark until this is true.** |
| `JINA_API_KEY` | — | Without it every page fetch fails and jobs finish `blocked` |
| `KORTIX_ENRICHMENT_MODEL` | `glm-5.2` | Credit-billed to the requesting account |
| `KORTIX_ENRICHMENT_JOB_TIMEOUT_MS` | `300000` | Per-job wall clock |
| `KORTIX_ENRICHMENT_JINA_RPM` | `60` | Outbound cap (process-local = global, see §4) |
| `KORTIX_ENRICHMENT_PROFILE_TTL_DAYS` | `60` | Cache freshness |
| `KORTIX_ENRICHMENT_REQS_PER_MIN_USER` / `_ACCOUNT` | `5` / `15` | Submit rate limits |
| `KORTIX_ENRICHMENT_WORKER_INTERVAL_MS` | `5000` | Tick period |

---

## 9. Troubleshooting: "my job is stuck in `queued`"

A row sitting at `queued` with `attempts = 0` and `locked_by = null` has **never
been looked at**. That is not a pipeline failure — the pipeline never ran. Work
down this list.

```sql
-- 1. Is anything claiming jobs at all?
select owner_id, expires_at, now() > expires_at as expired
from kortix.worker_leader_lease where lock_key = 'background-workers';

-- 2. What state is the job actually in?
select left(job_id::text,8), domain, status, attempts, error_code,
       locked_by, available_at, age(now(), created_at)
from kortix.enrichment_jobs order by created_at desc;
```

**Is the flag on in the process that is actually running?** Not in the file — in
the process. Environment variables are injected by dotenvx **at launch**;
`bun run --hot` reloads modules but never re-reads the process environment.
Editing `.env` after the server started changes nothing until a full restart.

```bash
ps -eo pid,lstart,command | grep 'bun run --hot'   # started when?
stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" apps/api/.env  # edited when?
```

If the process is older than the edit, that is your answer. Restart it.

**Is the leader the process you think it is?** This is the subtle one, and it
bites hardest in local development. Every API process pointed at the same
Postgres competes for one lease. If you run a primary checkout *and* a worktree
against the same local database, whichever started first usually holds it — and
if that one is built from a branch without the enrichment worker, it will happily
hold the lease, renew it forever, and drain nothing.

```bash
# who holds it — match owner_id's pid against your processes
for p in $(pgrep -f 'bun run --hot'); do
  echo "$p -> $(lsof -a -p $p -d cwd -Fn 2>/dev/null | grep ^n | cut -c2-)"
done
```

Symptom: the lease is alive and being renewed, yet jobs never leave `queued`.
Fix: stop the other checkout's API so the lease expires (≤60s) and the process
with the worker takes it, then wait one 5-second tick.

**Is the process a worker owner at all?** `runsSingletonWorkers()` returns false
only when *all four* of `KORTIX_TRIGGER_SCHEDULER_ENABLED`,
`KORTIX_PROJECT_MAINTENANCE_ENABLED`, `KORTIX_LEGACY_MIGRATION_WORKER_ENABLED`
and `KORTIX_SUNA_MIGRATION_WORKER_ENABLED` are explicitly `"false"`. Unset means
owner, so this only bites a deliberately API-only pod.

**Other states, briefly:**

- `running` with `locked_until` in the past → the worker died mid-job. The next
  tick reclaims it automatically; no action needed.
- `queued` with `attempts > 0` and `available_at` in the future → a transient
  failure is backing off. Read `last_error`.
- `failed` with `blocked` → the site refused us, or `JINA_API_KEY` is missing or
  rejected. Check `last_error`.
- `dead_lettered` → three transient failures. Read `last_error`; re-submit with
  `force: true` once the cause is fixed.

---

## 10. Where the code lives

```
apps/api/src/enrichment/
  index.ts                     app mount + worker start/stop
  errors.ts                    typed error codes
  schemas.ts                   CompanyProfile Zod contract
  routes/enrichment.ts         POST /domains, GET /jobs/{id}
  services/
    normalize.ts   safe-fetch.ts   discovery.ts   url-filter.ts
    jina-fetch.ts  consolidate.ts  extract.ts     gateway-chat.ts
    memory-write.ts             worker.ts
  repositories/
    jobs.ts  profiles.ts  page-cache.ts  memory-port.ts
```

Entry points outside the module: `POST /v1/projects/provision` and
`/v1/projects/create-repo` accept an optional `domain` and enqueue on success;
`packages/sdk` exposes `enrichDomain` / `getEnrichmentJob`; the create-project
modal and the onboarding wizard collect the domain in `apps/web`.

Design rationale and the deviations taken during implementation are in
[`docs/superpowers/specs/2026-07-24-domain-enrichment-design.md`](superpowers/specs/2026-07-24-domain-enrichment-design.md).
