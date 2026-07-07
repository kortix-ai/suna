---
name: finance-markets
description: "Public-market data and analysis: live and historical stock/ETF/crypto/index prices, market cap, valuation multiples, company financials (income statement, balance sheet, cash flow), earnings transcripts and estimates, analyst targets, dividends, debt, M&A, sector peers, ETF holdings, insider and institutional activity, private/pre-IPO valuations, and macro indicators (GDP, inflation, rates). Also covers filing-grounded facts — a company's officers, board, executive compensation, deal terms. Use for any question whose answer is a current or point-in-time market number, never a number from memory."
---

# Finance Markets

> **Requires a Kortix connector (market-data).** Marketplace skill — install it when a market-data provider is configured through Kortix. Every price, fundamental, and KPI in your answer must come from that connector, not from training data.

Answer public-market questions with numbers you actually pulled — quotes, fundamentals, earnings, estimates, ratios, macro series — and show where each one came from.

## The one rule that matters

Market data is stale the moment it leaves your weights. Current prices, market caps, margins, and KPIs are **not** in your training data, and a confidently-stated old number misleads the user worse than "I need to look that up." So:

- **Never answer a market number from memory** — not even for the biggest, most familiar names.
- **Never fetch it from the open web** — no search, no scraping, no URL fetches for prices or fundamentals. Web snippets are unstructured and often pre-revision. The connector returns structured, point-in-time, revisable data; the open web does not.
- The only exception: a specific datum the connector genuinely doesn't cover (see Routing below).

## Getting the connector

This skill reads from a market-data provider reached **through a Kortix connector** — for example a market-data API surfaced via Pipedream, or a provider you authorize with an API key. You query the provider through the connector bridge; you never hardcode a vendor's tool names.

1. **Check what's connected** — list usable connectors (`kortix executor connectors`, or the `connectors` MCP tool). A market-data provider in that list means data is live.
2. **If none is connected**, set it up in the same turn:
   - **App / OAuth provider** — mint a connect link (`connect` tool, or `kortix executor connect <slug>`). If the connector isn't on the project yet, add it first (`add_connector`, or `kortix executor add <slug> --provider pipedream --app <app>`), then connect.
   - **API-key provider** — mint a secret link (`request_secret`, or `kortix secrets request <PROVIDER_API_KEY>`); your code reads the key from env once it lands.
   - Surface the URL with a one-line "what this is for", end your turn, and verify on return. Don't ask the user to paste a raw key into chat or go hunting in a dashboard.
3. **Query, then cite** — pull the data, then state each figure with its provenance (below).

If a user names a preferred provider ("always use <X> for market data"), remember it and prefer it; surface a reconnect link rather than silently falling back if it's down.

## Reference-date discipline

Most time-sensitive lookups (financials, earnings, price history, schedules) need an explicit **as-of date**. "Latest" is ambiguous and non-reproducible — never leave it implicit.

1. **Pick the reference date.** Explicit in the question ("as of March 2024") → use it. Implied period ("Q4 results", "last year's revenue") → infer the date that returns it. Otherwise → today, from the session context.
2. **Map to the company's fiscal calendar, not the calendar year.** Fiscal year/quarter parameters follow the *company's* fiscal clock. Do not assume Jan–Dec; many large names don't use it.
3. **Historical prices** → pass the reference date as the explicit end date on price-history requests. Use live quotes only when the reference date is today.

Every table and report states the reference date it was built on: "As of 2026-06-29" or "TTM ending FY2025 Q2."

## Provenance discipline

Treat provenance as part of the answer, not an afterthought. A response full of market numbers with no traceable source is a failure.

- **Every figure carries its source and as-of date** — raw lookups (revenue, EPS, market cap, a balance-sheet line) and derived values (margins, growth, ratios) alike.
- **Derived values show their work** — record the formula and the input figures behind each computed metric, so a reader can retrace it.
- **Numbers come from a real pull.** If you didn't fetch it this session, you can't state it. No fabricated source labels, no "obvious" shortcuts for follow-ups.
- **Precision, not hedging.** Use the exact value the connector returned — "$21.09/share", not "around $21" or "~$21.09". The data is precise; present it that way.
- **Never invent.** If a value isn't available, render `—` or omit the row. Don't backfill with an estimate.

Note: scheduled or notification surfaces may render plainer text — there, just state the plain value with its source label; don't block a real number because a rich provenance link won't render.

## Data-source routing

For each public-company question, stop at the first source that answers it:

1. **Financial statements** — revenue, net income, margins, EPS, debt, cash, capex, FCF, SBC, dividends, shares, tax rate, and any ratio derivable from them (ROE, D/E, FCF margin, CAGR). For non-US tickers, expect different column naming — read the actual headers, don't assume.
2. **Earnings transcripts** — far more than EPS. Forward guidance, non-GAAP metrics, and company-specific KPIs (ARPU, take rate, GMV, same-store sales, subscriber counts, load factor), segment breakdowns, M&A rationale, and management Q&A. Try transcripts *before* any web search — they answer roughly half of what looks like it needs a filing. For guidance-vs-actuals, pull both the guidance quarter and the results quarter.
3. **Filings** — for point-in-time facts that live in SEC/EDGAR documents (officers and directors, board nominees, executive/director compensation, audit fees, deal and securities terms, proxy/8-K/10-K disclosures), do a filing lookup — never state these from memory. For *post-filing* news (a deal's status after a ruling), use web search instead.
4. **Private / pre-IPO** — for a specific private company's profile, funding rounds, or secondary-market marks, use the connector's private-markets data if available. Only for company-specific private lookups — not public tickers, not a user's own portfolio (that's `personal-finance`), not broad venture commentary.

## Analysis patterns

Fetch the component figures, compute locally, cite the result.

- **Profitability** — gross/operating/net margin, ROE = NI / equity, ROA = NI / assets, ROIC = NOPAT / invested capital.
- **Liquidity & leverage** — current ratio, quick ratio, D/E = total debt / equity, debt/EBITDA, interest coverage = EBIT / interest.
- **Comparables** — pick a peer set by sector and size, pull valuation multiples (P/E, EV/EBITDA, P/S, P/B, PEG) and growth, table them against each other and a sector benchmark.
- **DCF** — project FCF (operating cash flow − capex) from history, discount at WACC, add a Gordon-growth terminal value `FCF_final * (1+g) / (r−g)` with g ≈ 2–3%, subtract net debt, divide by shares for an implied price; compare to the live price for upside/downside.
- **Statistical** — from price history compute daily returns, annualized volatility `std(daily) * sqrt(252)`, beta vs a benchmark, correlation, Sharpe.

## Formatting

- **Currency** — `$0.45` · `$150.25` · `$12.5K` · `$1.2M` · `$150.5B` · `$2.1T`.
- **Percentages** — price changes signed (`+2.5%`, `-1.3%`); static ratios/yields unsigned (`3.5%`); growth as `+15% YoY`.
- **Tables** — right-align numbers, keep precision consistent, and pair every absolute value with a benchmark (vs sector, vs history). Lead with the insight, not a data dump.

Quick stock snapshot: price + change, market cap / P/E / div yield, day range and volume, 52-week range and position in it, a key-metrics table vs sector. Peer comparison: a valuation table and a profitability table, then 2–3 takeaways. DCF: assumptions, an FCF projection table, and a valuation bridge to the implied price.

## Gotchas

- **Adjusted vs raw prices** — price history is usually split/dividend-adjusted. Comparing it to a news-quoted or target price computed on raw prices will be wrong.
- **Stale financials near earnings** — statement data is the last *filed* period; in the weeks before a release it can be 3+ months old and misleading for fast-moving names. Flag the as-of date.
- **Splits break fixed thresholds** — a price alert pinned to a stored dollar level will fire phantom moves after a split. Trigger on return/percentage recomputed from fresh adjusted prices.
- **Scope** — this skill is public-market only. A user's own brokerage positions, balances, or transactions belong to `personal-finance`. Structured multi-name screens, investor-style scoring, portfolio risk, backtests, and formal thesis stress-tests belong to `investment-research` (load it alongside this one).
