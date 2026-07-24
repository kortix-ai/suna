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
| `result` | jsonb: `memoryPath`, `pagesFetched`, `blogPostsFetched`, `fetchTiers`, `crawlStatus`, `cacheHit` |

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

## 6. The stages

Once a job is claimed:

| # | Stage | What it does |
|---|---|---|
| 1 | **SSRF guard** | Resolve DNS, reject private/loopback/link-local/CGNAT/reserved addresses, https-only. Applied to the origin *and every discovered URL*, immediately before each fetch. |
| 2 | **Cache check** | Fresh profile in `enrichment_profiles` and not `force` → skip to stage 8. |
| 3 | **Discovery** | `robots.txt`, then `sitemap.xml` if it lists real pages; otherwise a depth-2, same-origin, ≤40-page crawl. Harvests JSON-LD, OpenGraph, meta — *and every outbound link*, classified into socials/emails/phones. Page bodies are discarded. |
| 4 | **Filter** | Canonicalize, dedupe, drop assets/archives/docs/auth/legal, rank by signal. Split into ≤40 site pages and ≤20 blog posts. |
| 5 | **Fetch** | Each URL through the fetch chain (see below) — concurrency 4, 15s each, one retry per tier, failures skipped. Page cache consulted first. |
| 6 | **Map** | Each page over ~4k chars gets its own small LLM call returning a structured summary; shorter pages pass through whole. |
| 7 | **Reduce** | One synthesis call over the summaries + trusted signals → the profile. JSON-schema constrained, Zod-validated, up to 2 repair rounds. Harvested socials/emails merged in **after** validation. |
| 8 | **Memory write** | One atomic commit of a folder: `profile.md`, `pages/<slug>.md`, `blog/<slug>.md`, plus a `MEMORY.md` block listing every file. |

### The fetch chain (stage 5)

A page is read by trying three tiers in order, first success wins. A tier fails
on transport error, any non-2xx (**including 401/402/429**), or an empty
document, and falls through to the next:

| Tier | How | Skipped when |
|---|---|---|
| `jina` | Jina Reader, renders JavaScript | no `JINA_API_KEY` |
| `firecrawl` | Firecrawl `/v1/scrape` | no `FIRECRAWL_API_KEY` |
| `direct` | SSRF-guarded fetch → `cheerio` + `turndown` | never |

This is why a dead Jina balance no longer produces an empty profile: most
company and personal sites are server-rendered and read perfectly on the free
`direct` tier. The job records which tier served each page in `result.fetchTiers`,
so a degraded run is visible rather than mysterious.

Some notes on why the rest is the way it is:

**Discovery harvests every outbound link.** The earlier version kept only
same-origin links and discarded page bodies after reading JSON-LD/OpenGraph, so
a site's X / GitHub / LinkedIn / Peerlist links never reached the model at all.
Now they are classified against a platform table and written into the profile
**deterministically** — the model cannot miss or invent them. Anything
unrecognized is kept as a plain "other links" list.

**Extraction is two passes.** One prompt holding 40 truncated pages is why the
old output was shallow — every page cut to 15k chars, blog posts reduced to
titles. Now each substantial page is summarized on its own (the *map* pass),
then one *reduce* call synthesizes the summaries into the profile. This lets all
40 pages contribute at full fidelity. A failed map call degrades that one page
to a raw excerpt rather than failing the job.

**The schema knows what it is looking at.** `subjectType` is detected from the
site — `company`, `person`, or `product` — and each shape gets the fields it
needs (pricing tiers, case studies, FAQ for a company; roles, projects, writing
for a person). A personal portfolio forced through a company schema is why an
earlier run produced a single line.

**JSON-LD is treated as ground truth.** A site publishing a `schema.org`
Organization block is handing us its legal name, logo, founders and socials as
data. That is worth more per token than the prose around it, so it goes into the
reduce prompt first and is labelled trusted.

**The model is untrusted.** Nothing it returns is stored until Zod accepts it.
`sources` is required and non-empty — a model that invents a company wholesale
tends to invent it without citations, so "where did this come from" is the
cheapest structural check against fabrication. A job that exhausts its repairs
fails as `extraction_failed` with the crawl preserved. A missing profile is
recoverable; a confidently wrong one in company memory is not.

**Memory is a folder, written in one commit.** The layout:

```
.kortix/memory/enrichment/<domain>/
  profile.md          rich distilled profile + fenced JSON
  pages/<slug>.md     cleaned page content, front-matter: source URL, fetchedAt, tier
  blog/<slug>.md      blog post content, same front-matter
```

`MEMORY.md` gets a block for the domain with a **nested bullet for every file** —
profile, each page, each blog post — so the index alone shows everything
available. The whole folder plus the index is one atomic
`commitMultipleFilesToBranch` call, with stale files from a previous run in the
same commit's `deletes`, so memory is never half-updated. Re-running replaces
the domain's block rather than appending a second one.

One subtlety this guards: on a re-enrichment, a category we have *no evidence*
about (e.g. a cache hit where the model cited no blog URLs) is passed as
`undefined`, meaning "leave existing files alone" — never as `[]`, which would
mean "confirmed empty, delete them". Getting that distinction wrong would delete
live files on a normal re-run.

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
| `JINA_API_KEY` | — | First fetch tier. Optional now — without it, fetching falls through to Firecrawl then a free direct fetch (see §6). |
| `FIRECRAWL_API_KEY` | — | Second fetch tier. Optional; skipped when unset. |
| `KORTIX_ENRICHMENT_MODEL` | `glm-5.2` | Credit-billed to the requesting account. Two-pass extraction means one call per large page plus one synthesis call. |
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
- `failed` with `blocked` → nothing readable at all: the site actively refused
  us on every fetch tier (challenge page / 403), or it genuinely has no content.
  A missing or out-of-credit `JINA_API_KEY` no longer causes this on its own —
  fetching falls through to Firecrawl and then a free direct fetch. Check
  `result.fetchTiers` to see which tier (if any) served pages.
- `succeeded` but the profile looks thin → check `result.pagesFetched`. If it is
  `0`, discovery found the site but every fetch tier failed, so the profile came
  from homepage metadata alone. `result.fetchTiers` shows what happened.
- `dead_lettered` → three transient failures. Read `last_error`; re-submit with
  `force: true` once the cause is fixed.

---

## 10. Where the code lives

```
apps/api/src/enrichment/
  index.ts                     app mount + worker start/stop
  errors.ts                    typed error codes
  schemas.ts                   CompanyProfile Zod contract (company + person)
  routes/enrichment.ts         POST /domains, GET /jobs/{id}
  services/
    normalize.ts   safe-fetch.ts   discovery.ts   url-filter.ts
    links.ts       page-fetch.ts   consolidate.ts chat-json.ts
    page-summary.ts (map)       extract.ts (reduce)  gateway-chat.ts
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
