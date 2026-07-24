# Enrichment Depth v2 — Implementation Plan

Turn a thin one-paragraph profile into a genuinely detailed company/person
dossier in project memory, and stop the pipeline from being one vendor's
outage away from producing nothing.

Current failure that motivates this: `pagesFetched: 0` on every run, because
Jina Reader returns `402 InsufficientBalance`. The profile that reached memory
was built from the homepage `<title>` and meta tags alone. Separately, outbound
social links (X, GitHub, Peerlist) are dropped during discovery and never reach
extraction at all.

## Global Constraints

Binding on every task. A reviewer should treat a violation as a defect.

1. **Tests ship with the change.** Every behavioural change has tests in the
   same commit. Run from `apps/api` with:
   `dotenvx run -- env KORTIX_URL=http://localhost:8008 bun test <path>`
   (this worktree's `.env` lacks `KORTIX_URL`; without it every test whose
   imports reach `config.ts` dies at env validation).
2. **Never `mock.module` a shared module** (`shared/db`, `node:dns/promises`,
   `llm-gateway/*`). It is process-wide in this suite and breaks sibling test
   files that exercise the same modules for real. Use dependency injection —
   the existing `EnrichmentJobDeps` / `fetchImpl` / `assertUrl` seams.
3. **Run sibling suites together** before claiming green:
   `bun test src/enrichment/ src/__tests__/integration-enrichment-worker.test.ts src/__tests__/unit-ssrf-guard.test.ts`.
   A per-file pass proves nothing about cross-file mock leakage.
4. **Every outbound URL passes the SSRF guard** (`assertSafeUrl` /
   `boundedFetch`) immediately before it is fetched. No exceptions, including
   new fetch tiers.
5. **No pushing.** Commit to the current branch only.
6. **No references to issue trackers** in code, comments, or commit messages.
7. **Match house conventions** — comments explain *why*, never narrate the
   diff; no comments in test files; typecheck must pass
   (`bunx tsc --noEmit -p tsconfig.json`).
8. **Enrichment must never fail the caller.** Degrade and record, don't throw
   at the user.

## Shared context

- Module: `apps/api/src/enrichment/` (`services/`, `repositories/`, `routes/`).
- The worker (`services/worker.ts`) runs stages in order and already takes
  injectable deps: `assertUrl`, `fetchImpl`, `runChat`, `memoryPortFor`.
- `boundedFetch` (`services/safe-fetch.ts`) is the SSRF-guarded fetcher with a
  timeout and byte cap; it returns `{status, ok, contentType, body, truncated}`.
- Extraction currently: one call, `~60k` token budget, blog reduced to
  titles+URLs, each page truncated to 15k chars.
- Memory write currently: two single-file commits
  (`.kortix/memory/enrichment/<domain>.md`, then a `MEMORY.md` index line).
- `commitMultipleFilesToBranch(project, {files, deletes, message})`
  (`projects/git/branches.ts`) commits many files atomically — currently unused
  by enrichment.

---

## Task 1 — Page fetch chain (remove the single vendor dependency)

**File:** `apps/api/src/enrichment/services/page-fetch.ts` (new), replacing the
fetch half of `jina-fetch.ts`.

Fetch one page's readable markdown by trying tiers in order, first success wins:

| Tier | How | When it is skipped |
|---|---|---|
| `jina` | `https://r.jina.ai/<url>`, bearer `JINA_API_KEY` | no key configured |
| `firecrawl` | `POST {FIRECRAWL_API_URL}/v1/scrape` `{url, formats:['markdown']}`, bearer `FIRECRAWL_API_KEY` | no key configured |
| `direct` | `boundedFetch` the URL, convert HTML→markdown with `cheerio` + `turndown` | never |

- A tier fails on: transport error, non-2xx (**including 401/402/429**), or an
  empty document. On failure, fall through to the next tier.
- `direct` strips `script`, `style`, `nav`, `footer`, `svg`, `noscript` before
  conversion, and prefers `main`/`article` when present.
- Add `turndown` to `apps/api/package.json` (already used in `apps/web`).
- Return `{url, markdown, tier, fromCache}`; `tier` is recorded so a degraded
  run is visible rather than mysterious.
- Keep the existing concurrency (4), per-URL timeout (15s), one retry **per
  tier**, RPM bucket, `assertUrl` before each request, and page-cache
  read/write behaviour from `jina-fetch.ts`.

**Tests** (`page-fetch.test.ts`, injected fetcher — no module mocks): each tier
serving successfully; 402 on Jina falling through to Firecrawl; both failing
falling through to direct; direct HTML→markdown conversion including tag
stripping; empty document treated as failure; cache hit skipping all tiers;
concurrency bound; abort stops early.

## Task 2 — Harvest outbound and social links

**File:** `apps/api/src/enrichment/services/links.ts` (new), wired into
`services/discovery.ts`.

Discovery discards page bodies and keeps only same-origin links, so social
profiles never reach extraction. Fix it at the source.

- While parsing each discovered page, collect **all** `a[href]` values,
  including cross-origin.
- Classify against a platform table by host: `x.com`/`twitter.com`, `github.com`,
  `linkedin.com`, `peerlist.io`, `youtube.com`, `instagram.com`, `dribbble.com`,
  `behance.net`, `bsky.app`, any `mastodon`-ish host, `npmjs.com`, `crunchbase.com`,
  `producthunt.com`, `discord.gg`/`discord.com`, `t.me`, `medium.com`,
  `substack.com`, `stackoverflow.com`, `gitlab.com`, plus `mailto:` → email and
  `tel:` → phone.
- Return `{ socials: {platform, url}[], emails: string[], phones: string[],
  otherExternal: string[] }`, deduped, normalized (strip tracking params,
  drop obvious asset links). Cap `otherExternal` at 50.
- Extend `StructuredSignals` with these fields; merge across pages, first value
  per platform winning.
- These are written into the profile **deterministically** by Task 4 — they must
  not depend on the model noticing them.

**Tests** (`links.test.ts`): classification table per platform; `mailto:`/`tel:`
extraction; dedupe of the same profile linked from several pages; tracking-param
stripping; asset/junk links excluded; cap enforced; a page with no outbound
links returns empty arrays.

## Task 3 — Profile schema v2 with subject detection

**File:** `apps/api/src/enrichment/schemas.ts`.

A personal portfolio forced through a company schema is why the output was one
line. Detect the subject and give each shape the fields it actually needs.

- Add `subjectType: 'company' | 'person' | 'product' | 'unknown'`.
- **Shared:** `name`, `tagline`, `description` (long-form, several paragraphs
  allowed), `socials[]`, `contact`, `blogPosts[]`, `sources[]` (min 1),
  `sectionSources[]`, `keyFacts[]` (`{label, value}`).
- **Company fields** (all optional, empty when not applicable): `positioning`,
  `products[]` (`{name, description, url, audience}`), `pricing`
  (`{model, currency, freeTier, tiers[]{name, price, cadence, highlights[], limits}}`),
  `team[]` (`{name, role, link, bio}`), `integrations[]`, `techStack[]`,
  `caseStudies[]` (`{title, client, url, summary}`), `faq[]` (`{question, answer}`),
  `locations[]`, `founded`.
- **Person fields:** `headline`, `bio`, `roles[]` (`{title, org, start, end, summary}`),
  `projects[]` (`{name, url, description, tech[]}`), `writing[]`, `skills[]`,
  `speaking[]`.
- `blogPosts[]` gains `summary` and `tags[]` alongside title/url/date.
- Keep `sources` required and non-empty — it is the anti-fabrication anchor.
- Keep the array-of-objects style for collections (constrained decoding handles
  string-keyed records badly).

**Tests** (extend `extract.test.ts` or a new `schemas.test.ts`): a company
profile validates; a person profile validates; empty `sources` rejected; unknown
`subjectType` rejected; optional collections default to `[]`; a profile with
both company and person fields populated still validates.

## Task 4 — Two-pass extraction

**File:** `apps/api/src/enrichment/services/extract.ts` (+ a new
`services/page-summary.ts` if it keeps files focused).

One prompt holding 40 truncated pages is why detail dies.

- **Map pass:** each page whose markdown exceeds `PAGE_SUMMARY_THRESHOLD`
  (4,000 chars) gets its own model call returning a compact structured summary:
  `{url, pageKind, purpose, keyPoints[], entities[], pricingTiers?[], quotes[]}`.
  Shorter pages skip the call and pass through whole — this keeps small sites
  cheap. Bounded concurrency (4), each failure degrading to a truncated raw
  excerpt rather than failing the job.
- **Reduce pass:** one synthesis call over the summaries, the short pages, and
  the trusted signals (JSON-LD/OG + Task 2's harvested links) producing the
  v2 profile. Keep the strict Zod gate and the 2-repair loop.
- The harvested socials/emails from Task 2 are **merged into the result after
  validation**, deduped against whatever the model returned. Model output never
  removes a deterministically harvested link.
- Prompt instructs the model to detect `subjectType` from the evidence.
- Budgets: reduce-pass input capped at ~80k tokens; map summaries are small
  enough that 40 pages fit.

**Tests** (injected `chat` function, no module mocks): short pages skip the map
call; long pages get one map call each; a failed map call degrades to an excerpt
and does not fail the job; the reduce pass receives the summaries; harvested
socials survive even when the model omits them; the repair loop still works;
`extraction_failed` after the budget is exhausted.

## Task 5 — Memory writer v2 (folder + full index)

**File:** `apps/api/src/enrichment/services/memory-write.ts`.

Memory becomes a folder per domain, written in ONE atomic commit.

```
.kortix/memory/enrichment/<domain>/
  profile.md            rich rendered profile + fenced JSON
  pages/<slug>.md       cleaned page content, front-matter: source URL, fetchedAt, tier
  blog/<slug>.md        blog post content, same front-matter
```

- `MEMORY.md` gets, under `## Enriched companies`, a parent line for the domain
  **and a nested bullet for every generated file** — profile, each page, each
  blog post — so the index alone shows everything available. Idempotent: the
  whole block for that domain is replaced, matched on the domain's folder path.
- Use `commitMultipleFilesToBranch` for a single atomic commit of the folder
  plus the index, with `deletes` for files from a previous run that no longer
  exist (stale pages must not linger).
- Slugs derive from the URL path, lowercased, non-alphanumerics collapsed to `-`,
  deduped with a numeric suffix, capped at 80 chars.
- Keep the CAS retry-with-re-read.

**Tests:** folder layout; front-matter contents; MEMORY.md lists every file;
re-running replaces the block rather than appending a second one; stale files
from a previous run appear in `deletes`; slug collisions get distinct names;
one commit call, not N.

## Task 6 — Worker wiring and budgets

**File:** `apps/api/src/enrichment/services/worker.ts` (+ integration test).

- Thread the new stages: fetch chain → links → map/reduce extraction → memory v2.
- Budgets: up to **40 site pages** plus up to **20 blog posts** fetched in full
  (blog posts are usually the richest material; today they contribute only a
  title).
- `result` jsonb gains `blogPostsFetched`, `fetchTiers` (`{jina, firecrawl, direct}`
  counts) and keeps `pagesFetched`, `crawlStatus`, `cacheHit`, `memoryPath`.
- A cache hit still writes the full folder — the cached profile plus the cached
  page markdown — because the memory write is per-project even when the crawl
  is shared.
- Update `src/__tests__/integration-enrichment-worker.test.ts` for the new
  result shape and folder write, keeping its no-module-mock dependency injection.

## Task 7 — Update the docs

- `docs/DOMAIN_ENRICHMENT_ARCHITECTURE.md`: the fetch chain and its tiers, the
  two-pass extraction, the memory folder layout and full index, the new result
  fields, and the revised cost figure.
- `docs/superpowers/specs/2026-07-24-domain-enrichment-design.md`: append a v2
  section recording what changed and why, in the same style as the existing
  implementation-deltas block.
