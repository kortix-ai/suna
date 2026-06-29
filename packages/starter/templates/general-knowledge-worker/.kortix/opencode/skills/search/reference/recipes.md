# Search recipes

End-to-end shapes for the common jobs. Each is the `SKILL.md` loop tuned for a goal. Adapt the queries; keep the discipline (dedup, snippet-first, cite what you read).

## Verify a claim

Goal: is X true? Search for it, against it, and the correction.

```
web_search(
  "<claim> evidence ||| <claim> debunked OR false ||| <claim> fact check ||| <claim> original source",
  search_depth="advanced",
)
```

- Read the strongest source on each side, not just the top result.
- Weigh by source quality: primary data and official records over aggregators and blogs.
- Report the verdict with confidence and the disagreement, if any. If sources conflict and none is authoritative, say it's unresolved.

## Compare options (X vs Y)

Goal: a decision between alternatives.

```
web_search(
  "X vs Y comparison 2026 ||| X pricing tiers ||| Y pricing tiers ||| X Y limitations review",
)
```

- Scrape each product's own pricing/spec page for the hard numbers (snippets lie about price).
- Pull independent reviews for the limitations the vendor won't list.
- Output a comparison table with a one-line recommendation tied to the user's stated needs.

## What happened (news)

Goal: current events, breaking developments.

```
web_search(
  "<topic> latest ||| <topic> what happened ||| <topic> official statement",
  topic="news",
  num_results=10,
)
```

- `topic="news"` and trust `published_date` — drop anything stale.
- Corroborate across at least two independent outlets before stating a fact.
- Lead with the most recent confirmed development; note what's still unconfirmed.

## Pull facts from specific URLs

Goal: the user already named the pages.

```
scrape_webpage("https://…/a, https://…/b, https://…/c")
```

- Batch them; read the markdown; extract what was asked.
- A GitHub URL → use `gh` via bash instead of scraping.
- A page that scrapes thin (paywall, JS app) → say so and offer the snippet or an alternate source.

## Gather sources for a brief

Goal: a sourced foundation for writing, not the writeup itself.

- Fan out discovery across the brief's sub-themes (one `web_search` slot each).
- Dedup, then scrape the best few per theme into a working dir (see `reference/scaling.md`).
- Hand back `notes.md` plus a clean source list. If it grows into a full cited report, switch to the `deep-research` skill.
