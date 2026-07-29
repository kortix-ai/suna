# Scaling the search loop

How to run search/fetch wide, cheap, and resumable. The simple path in `SKILL.md` is enough for one-shot questions; reach here when a task spans many queries, many pages, or more than one work session.

## Fan-out

Both tools parallelize internally — express breadth in a single call, never a loop of single calls.

- `web_search` batches with `|||`. Vary the angle per slot: definition, latest, counter-evidence, official source.
- `scrape_webpage` batches with commas. One call, many URLs, per-URL success in the result.

```
# discovery: 4 angles, one round trip
web_search(
  "GLP-1 drugs cardiovascular outcomes trial ||| semaglutide heart attack risk reduction evidence ||| GLP-1 long-term side effects 2026 ||| GLP-1 cardiovascular benefit independent of weight loss",
  num_results=8,
  search_depth="advanced",
)

# then read the survivors in one shot
scrape_webpage("https://nejm.org/…, https://fda.gov/…, https://nature.com/…")
```

Sizing:

- `num_results` 5–8 for discovery; raise toward 20 only when you need exhaustive coverage of one angle.
- 3–5 query slots per `web_search` call is the sweet spot. More than that and the angles start overlapping.
- Scrape in batches of roughly 5–10 URLs. Larger batches lose more work when one page hangs.

## Dedup before fetch

The same URL appears across query variants. Collapse on `url` first — a scrape is the expensive step, so never spend two on one page.

1. Flatten every `results[]` block from the batch into one list.
2. Group by `url`; keep the entry with the longest `snippet` (most context) and the best `score`.
3. Rank by `score` and recency, take the top few, scrape those.

When freshness matters, prefer the entry with the newer `published_date` over the longer snippet.

## Disk as working memory

Hold notes, not raw pages, in context. For any multi-step job, give the task a working dir and write through it:

```
search/{topic-slug}/
  index.md        # one line per URL: title, date, status (seen / fetched / used)
  pages/          # raw scraped markdown, one file per URL
    01-source.md
    02-source.md
  notes.md        # the facts you extracted, each tagged with its source number
```

Loop: scrape → write the markdown to `pages/NN-*.md` → extract the facts you need into `notes.md` with a source tag → drop the raw page from context. Synthesize from `notes.md` and `index.md` at the end, not from a context full of full-text pages.

## Resumable batches

Long jobs get interrupted. Make re-runs cheap by making the work idempotent:

- Name page files deterministically from the URL (e.g. a short slug or hash). Before scraping, skip any URL whose file already exists in `pages/`.
- Keep `index.md` as the ledger of what's done. On resume, read it and process only the gaps.
- Write each batch to disk as it completes, not all at the end — a crash then costs one batch, not the whole run.

This is the manual version of a checkpoint: the filesystem is the record of completed work, so a second run continues instead of restarting.

## Extraction without an extraction API

There is no separate "extract" tool — **you are the model**. For a handful of pages, read the returned markdown and pull the facts inline. For a large pool, two routes:

- **Mechanical pulls** — when you need a specific field from many saved pages (a price, a date, a version), `grep`/`bash` over `pages/*.md` rather than re-reading each in context.
- **Delegate** — split the pool by subtopic and hand each to a parallel subagent (or a background session for long-running work). Each returns distilled notes; you combine them. This keeps any single context small and lets independent reads run at once.

Escalate to delegation once a single pass would blow past a comfortable context — roughly when you're past a dozen full pages or several distinct subtopics.

## When to hand off

If the task is a full cited report with adversarial verification across many sub-questions, use the `deep-research` skill — it wraps this same search/fetch loop in a planned, checkpointed harness. This skill is the fast path: targeted lookups, claim checks, comparisons, and source gathering.
