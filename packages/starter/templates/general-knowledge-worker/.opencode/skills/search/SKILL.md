---
name: search
description: "Find and read information on the open web — fan-out web/news/finance search plus full-page fetching and source extraction. Use to answer current questions, gather and cite sources, verify a claim, or pull text from specific URLs. Triggers: 'search the web', 'look this up', 'find sources on', 'what's the latest on', 'fetch this page', 'is it true that…', 'compare X vs Y'."
defaultProjectInstall: true
---

# Search

Two tools cover the whole loop: `web_search` finds pages, `scrape_webpage` reads them. Most questions resolve from search snippets alone — only fetch a page when a snippet can't settle the point.

## The loop

1. **Frame** — restate the question as 2-4 concrete things you need to know.
2. **Search** — fan out one batched `web_search`, one query per angle (see [Querying](#querying)).
3. **Triage** — scan titles, snippets, and scores; pick the few URLs worth reading; drop duplicates.
4. **Fetch** — `scrape_webpage` the survivors in a single batched call.
5. **Extract** — pull the facts you need out of the returned markdown. You are the extractor; there is no separate extraction model to call.
6. **Answer + cite** — synthesize, then list every URL you actually used as markdown links.

Stop the moment the question is answered. Don't fetch a page whose snippet already gave you the fact.

## Tools

### web_search

`web_search(query, num_results?, topic?, search_depth?)`

| Arg | Values | Notes |
|-----|--------|-------|
| `query` | string | Batch many in one call with `\|\|\|`: `"a \|\|\| b \|\|\| c"`. Each runs in parallel. |
| `num_results` | 1–20, default 5 | Per query, not a batch-wide cap. |
| `topic` | `general` (default), `news`, `finance` | `news` for breaking/current events, `finance` for markets, tickers, filings. |
| `search_depth` | `basic` (default), `advanced` | `advanced` is slower and more thorough — reserve it for hard or ambiguous questions. |

Each query returns JSON: a synthesized `answer`, then `results[]` of `{title, url, snippet, score, published_date}`, plus any `images[]` of `{url, description}`. Batched calls return `{batch_mode, total_queries, results[]}` — one block per query, in order. A failed query comes back as `{query, success: false, error}` without sinking the rest.

The `snippet` is already query-focused — treat it as the cheap answer and escalate to a fetch only when it's thin or contested. `score` ranks relevance; `published_date` is your recency signal.

### scrape_webpage

`scrape_webpage(urls, include_html?)`

| Arg | Values | Notes |
|-----|--------|-------|
| `urls` | string | One URL, or several comma-separated: `"https://a.com, https://b.com"`. Batch in one call. |
| `include_html` | bool, default false | Leave off — markdown is what you want almost always. |

Returns clean markdown as `content` (with `title`, `content_length`, `metadata`). Multi-URL calls return `{total, successful, failed, results[]}` with per-URL success, so one bad page doesn't sink the others. Timeouts are retried internally. For GitHub repos or files, skip this and use `gh` via bash instead.

## Querying

- Keep each query to a handful of strong keywords. Vary the **angle** across the batch, not just the wording: claim plus counter-claim, official source plus independent coverage, and a dated query for anything time-sensitive.
- Set `topic` per query: `news` for "what happened", `finance` for numbers and markets, `general` for the rest.
- Reach for `search_depth="advanced"` only after `basic` comes back thin — it costs latency.
- For scholarly sources, point queries at the literature (`… systematic review`, `site:arxiv.org`, journal names) or load the `openalex-paper-search` skill for a real paper index.

Example fan-out:

```
web_search(
  "EU AI Act high-risk obligations enforcement date ||| EU AI Act 2026 compliance deadline ||| AI Act general-purpose model rules industry criticism",
  search_depth="advanced",
)
```

## Patterns that scale

- **Fan out, don't loop.** One batched call beats N sequential ones — both tools parallelize internally.
- **Dedup before you fetch.** The same URL surfaces across query variants. Collapse on `url`, keep the richest snippet, *then* spend a scrape.
- **Snippet-first.** Fetch only the URLs whose snippet didn't close the question.
- **Disk is your memory.** Beyond a quick lookup, write scraped pages and extracted notes to a working dir and read them back selectively, rather than holding raw page text in context. This also makes long jobs resumable.
- **Big pools → batch and delegate.** Reading dozens of pages: scrape in batches, write each to disk, process in chunks — or hand subtopics to parallel subagents — instead of one giant context.

Full mechanics in [`reference/scaling.md`](reference/scaling.md). End-to-end recipes in [`reference/recipes.md`](reference/recipes.md).

## Output

Every factual claim traces to a page you read or a snippet you saw.

- End with a **Sources** section of markdown links: `[Title](url)`.
- Cite inline where it matters; quote directly only when exact wording carries weight.
- Flag disagreement between sources instead of smoothing it over. Say so when the evidence is thin or absent — "no solid source found" is a valid answer.
- Never invent a URL. If you didn't open it, don't cite it.

## Pitfalls

- A high `score` means relevant, not correct — read before trusting.
- Snippets go stale. Check `published_date` on time-sensitive facts and prefer `topic="news"`.
- Paywalled pages scrape thin — fall back to the snippet or a secondary report, and note the gap.
- Read the `error` field on a failed scrape instead of retrying blindly; it tells you why.
- GitHub, large PDFs, and login-walled pages are poor scrape targets — use `gh`, a PDF route, or a different source.
