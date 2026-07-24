# Domain Enrichment — Design

**Date:** 2026-07-24
**Status:** Approved
**Scope:** `apps/api` — new `src/enrichment/` module, three DB tables, one gateway export.

## 1. Summary

A user submits a domain for a project. The API validates and normalizes it, enqueues a durable job, and returns immediately. A background worker crawls the company's public site, extracts a structured company profile with an LLM, and commits it into the project's company memory (`.kortix/memory/`). Profiles are cached across requests for 60 days; every extracted fact traces to a source URL; nothing invalid is ever stored.

## 2. Decisions (locked)

| Topic | Decision | Rationale |
|---|---|---|
| Queue | Postgres queue table + leader-elected in-process worker (model: `session_lifecycle_commands`) | Repo has zero Redis/queue deps; all async coordination is Postgres-native. No new infra. |
| Discovery crawl | Hand-rolled BFS on `safeEgressFetch` + `cheerio` (parser only) | Crawlee v3 fails under Bun and its own HTTP client bypasses the SSRF guard (P0 violation). |
| Page fetch | Jina Reader (`https://r.jina.ai/<url>`), `JINA_API_KEY` header | Handles JS rendering; no Playwright, no browser infra. |
| Extraction model | In-process LLM gateway singleton, default `glm-5.2`, configurable via `KORTIX_ENRICHMENT_MODEL` | No free model exists (free tier `models: []`; OpenCode Zen `*-free` ids are skipped at the provider level). `glm-5.2` is openai-compatible so `response_format: json_schema` passes through. |
| Memory write | Direct commit to the project's default branch via the existing repo-commit engine — no change request | Matches the `channel-manifest` background-commit precedent; programmatic CR creation does not exist and is out of scope. |
| Profile placement | `.kortix/memory/enrichment/<domain>.md` sub-file + one idempotent index line in `MEMORY.md` | `MEMORY.md` is a one-line-per-subfile index by the memory system's own convention. |
| Module location | `apps/api/src/enrichment/` | Features live at `src/<name>/`; no `src/modules/` exists. |
| Rate limits | Existing in-memory `TokenBucketRateLimiter` + `enforceRateLimit` (per-user and per-account buckets) | The established pattern; per-replica approximate like every existing limit. |
| Jina global RPM | Worker-side token bucket | Singleton workers run only on the leader replica, so a process-local bucket is effectively global. |

## 3. Data model

Three tables in the `kortix` schema (Drizzle schema + generated migration).

**`enrichment_jobs`** — durable queue, modeled on `session_lifecycle_commands`:
- `job_id` uuid PK, `account_id` uuid NOT NULL, `project_id` uuid NOT NULL → `projects`, `created_by` uuid
- `domain` text NOT NULL (normalized), `idempotency_key` text NOT NULL (`<project_id>:<domain>`)
- `status` enum `queued | running | succeeded | failed | dead_lettered`
- `error_code` text nullable — `invalid_domain | blocked | timeout | extraction_failed | internal_error`
- `last_error` text, `attempts` int default 0, `available_at` timestamptz (backoff), `locked_by` text, `locked_until` timestamptz
- `payload` jsonb (`{ force: boolean }`), `result` jsonb (`{ domain, memoryPath, crawlStatus, pagesDiscovered, pagesFetched, cacheHit }`)
- `created_at`, `updated_at`, `finished_at`
- Indexes: `(status, available_at)` for the due-scan; **partial unique** on `idempotency_key WHERE status IN ('queued','running')` for in-flight dedup.

**`enrichment_profiles`** — cross-request domain cache (global; public web data):
- `domain` text PK (normalized), `profile` jsonb NOT NULL (validated CompanyProfile), `crawl_status` text (`complete | partial`), `crawled_at` timestamptz NOT NULL, `model` text
- Freshness: `crawled_at > now() - ttl` (default 60 days, `KORTIX_ENRICHMENT_PROFILE_TTL_DAYS`). `force` bypasses.

**`enrichment_page_cache`** — per-URL markdown cache:
- `url_hash` text PK (sha-256 of normalized URL), `url` text NOT NULL, `markdown` text NOT NULL, `fetched_at` timestamptz NOT NULL
- Reused on re-enrichment; also serves as the persisted raw crawl when extraction fails. Index on `fetched_at` for pruning.

## 4. API

Mounted at `app.route('/v1/enrichment', enrichmentApp)`, `supabaseAuth` on `*`, OpenAPI routes via `makeOpenApiApp<AppEnv>()`.

**`POST /v1/enrichment/domains`** — body `{ domain: string, projectId: string, force?: boolean }`
1. Rate limits: per-user and per-account token buckets (`enforceRateLimit`), config-driven.
2. Resolve tenancy: `resolveScopedAccountId`; verify the project belongs to the account.
3. Normalize domain (below); invalid → `400 { error: 'invalid_domain' }`.
4. In-flight dedup: existing `queued|running` job for `<projectId>:<domain>` → return that job (`200`).
5. Enqueue: insert job (`queued`, `available_at = now()`), return `202 { jobId, status: 'queued' }`. Cache freshness is evaluated by the worker (a fresh cached profile short-circuits crawl + extract but still performs the memory write for this project).

**`GET /v1/enrichment/jobs/:id`** — returns `{ jobId, domain, status, errorCode?, result?, createdAt, finishedAt }`. Scoped to the caller's account; unknown or foreign id → 404.

**Domain normalization** (`services/normalize.ts`): accept bare domain or URL → extract host, lowercase, strip one leading `www.`, require ≥2 dot-separated labels of `[a-z0-9-]` (punycode via `URL` parsing), reject IP literals and single-label hosts. Canonical origin: `https://<domain>`.

## 5. Worker pipeline

Registered in `startSingletonWorkers()` behind `KORTIX_ENRICHMENT_WORKER_ENABLED` (leader-only, like the other four workers). Interval drain (default 5s): claim due jobs by lease (`locked_by`/`locked_until = now() + 6 min`), max 2 concurrent jobs in-process. Each job runs under `AbortSignal.timeout(KORTIX_ENRICHMENT_JOB_TIMEOUT_MS)` (default 5 min) → `timeout` error.

Stages:

1. **SSRF gate (P0).** `assertSafeEgressUrl` on the canonical origin before anything else, and on **every** URL discovered later before it is fetched or handed to Jina. All our-network fetches (robots, sitemap, discovery pages) go through `safeEgressFetch` (DNS-resolves first, rejects private/loopback/link-local/CGNAT/reserved v4+v6, re-validates every redirect hop, https-only). The module adds a `boundedFetch` wrapper: per-request timeout + response byte cap (the guard itself has neither). DNS `NXDOMAIN`/resolution failure → `invalid_domain`. Note: Bun's fetch cannot pin a connect-time IP; rebinding is mitigated by resolve-time validation of every record — the runtime's ceiling.
2. **Cache check.** Fresh `enrichment_profiles` row and not `force` → skip to stage 8 (memory write) with the cached profile; result marks `cacheHit: true`.
3. **Discovery.** `robots.txt` fetched and parsed (`robots-parser`); disallowed paths are excluded from everything below. `sitemap.xml` (+ index sitemaps, bounded) first — if, after the stage-4 filter, it yields at least one priority URL beyond the homepage, no crawling. Otherwise BFS with `cheerio`: same-origin, depth 2, max 40 pages fetched, extracting links plus structured signals — JSON-LD (`schema.org` Organization/Person), OpenGraph, and meta tags. Page bodies are discarded; discovery produces URLs + signals only. Homepage `403`/challenge-page detection → `blocked` (with a partial profile from whatever signals were gathered, if any).
4. **Filter.** Normalize URLs (strip fragments, `utm_*`/`gclid`/`fbclid` params, trailing slashes, lowercase host), dedupe, exclude assets/`wp-content`/`static`/`tag`/`category`/`page/N` pagination/`docs`/`api`/auth/legal paths, rank by signal — homepage, `/about*`, `/team`, `/company`, `/pricing`, `/product*`, `/features`, `/contact` = full-content priority; `/blog*` = titles + URLs only — cap at 40.
5. **Fetch.** Each URL through Jina Reader with `Authorization: Bearer <JINA_API_KEY>`: per-job concurrency 4, 15s timeout per URL, 1 retry, failures skipped (never fatal); worker-global token bucket keeps total Jina traffic under `KORTIX_ENRICHMENT_JINA_RPM`. Results cached in `enrichment_page_cache`; cache consulted before fetching. Zero pages fetched **and** no structured signals → `blocked`.
6. **Consolidate.** Merge page markdown + JSON-LD/meta signals into one extraction input under a ~60k-token budget: priority pages full content truncated to ~15k chars each, blog pages contribute title + URL lines only, lowest-priority content trimmed first. JSON-LD is labeled as trusted ground truth in the input.
7. **Extract.** One call through the exported gateway singleton (`gateway.chatCompletions`, model `KORTIX_ENRICHMENT_MODEL`, `response_format: json_schema` derived from the Zod schema via `zod-to-json-schema`). Prompt contract: JSON only; unknown fields `null`; never invent people, emails, or facts absent from the input; cite source URLs per section; top-level `sources[]` mandatory. Response → strict Zod parse; on failure, retry with the validation errors appended (max 2 repairs); still failing → `extraction_failed`, raw crawl preserved (page cache + URL list in `result`), **no profile stored**. On success: upsert `enrichment_profiles`.
8. **Memory write.** Load `ProjectRow` by `project_id` (channel-manifest pattern — `commitRepoFile` handles auth internally via `withProjectGitAuth`). Render the profile to markdown (overview, product, team, pricing, blog index, contact, socials, sources, `crawledAt`, status complete/partial, plus the JSON in a fenced block) and commit two files sequentially through the existing engine: `.kortix/memory/enrichment/<domain>.md` (idempotent full-file replace), then `MEMORY.md` with one index line under an `## Enriched companies` heading (idempotent line upsert matched on the sub-file link; heading created if absent). Profile-then-index order so a failure never leaves a dangling index entry. Commit CAS conflicts retried ×3 with re-read.

**Retry policy:** transient failures (network, 5xx from Jina/gateway, commit CAS exhaustion) are recorded as `internal_error` → `attempts + 1`, backoff via `available_at` (1 min, 5 min), `dead_lettered` after 3. Permanent failures (`invalid_domain`, `blocked`, `extraction_failed`) → `failed` immediately with `error_code`. `timeout` retries once, then `failed`.

`internal_error` was added to the taxonomy during implementation. Without it, any failure on our side (a database error, an upstream 5xx, a bug) had to borrow the `timeout` code — which misreports the cause to the user as the site being slow, and wrongly inherits timeout's deliberately short retry budget.

## 6. Extraction schema (Zod, `schemas.ts`)

```
CompanyProfile {
  name: string | null
  tagline: string | null
  description: string | null
  products: { name: string; description: string | null; url: string | null }[]
  team: { name: string; role: string | null; link: string | null }[]
  socials: Record<string, string>          // platform → url
  pricingSummary: string | null
  blogPosts: { title: string; url: string; date: string | null }[]
  contact: { email: string | null; phone: string | null; address: string | null }
  sectionSources: Record<string, string[]> // section → source URLs
  sources: string[]                        // min 1 — required
}
```

## 7. Configuration (`src/config.ts`)

- `JINA_API_KEY` (optional string; validation warning if the worker flag is on without it)
- `KORTIX_ENRICHMENT_WORKER_ENABLED` (bool, default false)
- `KORTIX_ENRICHMENT_MODEL` (default `glm-5.2`)
- `KORTIX_ENRICHMENT_REQS_PER_MIN_USER` (default 5), `KORTIX_ENRICHMENT_REQS_PER_MIN_ACCOUNT` (default 15)
- `KORTIX_ENRICHMENT_JINA_RPM` (default 60)
- `KORTIX_ENRICHMENT_PROFILE_TTL_DAYS` (default 60)
- `KORTIX_ENRICHMENT_JOB_TIMEOUT_MS` (default 300000)

## 8. Module layout

```
apps/api/src/enrichment/
  index.ts                    # enrichmentApp + startEnrichmentWorker/stopEnrichmentWorker
  schemas.ts                  # CompanyProfile + route DTOs
  routes/enrichment.ts        # POST /domains, GET /jobs/:id
  services/
    normalize.ts  discovery.ts  url-filter.ts  jina-fetch.ts
    consolidate.ts  extract.ts  memory-write.ts  worker.ts
  repositories/
    jobs.ts  profiles.ts  page-cache.ts
```

Cross-cutting changes: Drizzle schema + migration (three tables); config vars; mount + worker registration in `src/index.ts`; hoist and export the gateway singleton from `src/llm-gateway/wire.ts` (single instance — circuit breakers are per-instance). New deps: `cheerio`, `robots-parser`, `zod-to-json-schema` (zod v3 cannot emit JSON schema natively).

## 9. Testing

House conventions: co-located `*.test.ts` (bun:test, `mock.module` + `globalThis.fetch` swap), `integration-*` prefix for real-Postgres tests, default suite excludes integration by filename.

- `normalize.test.ts` — accept/reject table (bare domain, URL forms, www-strip, IP literals, single-label, punycode).
- `url-filter.test.ts` — normalization (fragments/utm/slashes), exclusion list, ranking order, 40-cap.
- `discovery.test.ts` — sitemap-first short-circuit, BFS depth/count caps, JSON-LD/OG harvest from fixture HTML, robots exclusion; fetch mocked.
- `extract.test.ts` — happy parse, repair loop feeding Zod errors back, `extraction_failed` after 2 repairs, no-invented-data schema gates; gateway mocked.
- `memory-write.test.ts` — markdown render, idempotent sub-file replace + index-line upsert, heading creation.
- SSRF: the existing `unit-ssrf-guard.test.ts` already covers the attack list (localhost, `127.0.0.1`, `169.254.169.254`, `::1`, `10.x`, `192.168.x`, redirect-to-internal, DNS-rebind, mixed-record); new tests only for `boundedFetch` (timeout, byte-cap) and pipeline-level "discovered URL must be re-validated".
- `integration-enrichment-worker.test.ts` — full worker cycle against local Postgres with Jina + gateway fetches mocked: enqueue → claim → discovery (fixture site) → fetch → extract → profile row + job `succeeded`; plus in-flight dedup, cache-hit short-circuit, `extraction_failed` preservation, lease expiry reclaim.

## 10. Out of scope (v1)

Change-request-based memory writes; scheduled re-enrichment / change monitoring; RSS/feed ingestion; content-hash re-crawl gating; agent-callable enrichment tool; anti-bot evasion (blocked sites degrade to `blocked`/partial honestly); cross-tenant cache policy controls (cache is global; revisit if a deployment mode needs isolation).
