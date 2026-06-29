---
name: investment-research
description: "Structured, multi-step investment research: screen and rank stocks against criteria, stress-test a bull/bear investment thesis, evaluate a name through a famous investor's philosophy (Buffett, Lynch, Druckenmiller, Soros, Dalio, Ackman, Burry, Wood), analyze a portfolio's diversification and risk, or backtest a historical strategy. Use when the request is a workflow — screening, scoring, risk analysis, backtest, or a formal thesis pressure-test — not a one-line buy/sell read."
---

# Investment Research

> **Requires a Kortix connector (market-data; brokerage too for portfolio review).** Marketplace skill — install it when the connector is configured. Load the `finance-markets` skill alongside this one — it owns the data-pull, reference-date, and provenance mechanics this skill builds on.

Every conclusion here rests on data you pulled, not on a hunch. If a tool call can settle a question, make the call before you opine. A quick single-name "is this a buy?" verdict is a `finance-markets` job — reach for this skill only when the work is a structured workflow.

## Pick the mode

| The ask | Mode |
| --- | --- |
| "Find stocks that…", screen, filter, rank a universe | **Screen** |
| Lay out and pressure-test a structured bull/bear case | **Stress-test** |
| "Would Buffett buy this?", evaluate by an investor's style | **Investor lens** |
| Diversification, concentration, risk, rebalancing of holdings | **Portfolio X-ray** |

### Screen

Narrow a universe to the best candidates. Seed it (e.g. from an ETF's constituents or a sector list), apply the user's filters in code, then enrich the surviving 5–10 names with quotes, financials, and earnings detail. Parallelize the enrichment when it's more than a few tickers. Surface the shortlist with the metrics that drove the cut.

### Stress-test

Take one thesis and try to break it. First restate it crisply: **asset, belief, time horizon, expected outcome.** Then gather the evidence — multi-year financial trends, ratio analysis, earnings transcripts (guidance vs actuals, shifts in management tone), price context, and qualitative signals (competitive dynamics, news). For each load-bearing assumption, write the bull case and the bear case side by side with the data behind each. Close with a thesis-strength rating, the key supporting evidence, the key risks, and an upside / base / downside scenario table.

### Investor lens

Score a name against a named investor's discipline. Read the matching profile below, mark each quantitative criterion **Pass / Borderline / Fail** against the actual figures, and judge the qualitative factors from transcripts and news. Present a scorecard — criterion, threshold, actual, verdict — then a one-paragraph "what this investor would likely conclude."

### Portfolio X-ray

Assess a real portfolio's composition and risk. Check for a connected **brokerage** first (below) before asking the user to type holdings; fall back to a previously saved portfolio if one exists. Then compute:

- Concentration — position sizes and a Herfindahl (HHI) score
- Correlation matrix from daily returns
- Portfolio beta, annualized volatility, and Sharpe vs a broad benchmark
- Weighted-average valuation (P/E, P/S, P/B) vs market averages

Flag: any single position >20%, any pair correlation >0.8, any sector >40%, weighted P/E above 2x or below 0.5x the market.

## Getting the connectors

- **Market data** — required for every mode. See the `finance-markets` skill for the connect/secret-link flow; verify with `kortix executor connectors`.
- **Brokerage** — only Portfolio X-ray needs it, and only when the user wants their *actual* holdings analyzed. It's reached through a Kortix connector to an account-aggregation or brokerage provider (for example a Plaid-style aggregator authorized via Pipedream). Mint a connect link (`connect` tool, or `kortix executor connect <slug>`; add it first with `add_connector` if it's not on the project), surface the URL, end your turn, and verify on return. If nothing's connected and the user would rather just list positions, work from what they give you — never fabricate holdings.

## Investor profiles (Investor lens)

Each profile is a lens: a few hard screens plus the softer judgment calls that matter to that investor. Treat the thresholds as guidelines, not gospel.

**Warren Buffett — durable franchises, bought sensibly.** Wants a wonderful business at a fair price, held indefinitely. Screens: 5-yr ROE consistently >15%, D/E <0.5, FCF positive and rising, net margin >15%, P/E sane relative to growth, steady (not lumpy) revenue. Judgment: a real moat (brand, switching costs, network, cost edge), a business he can explain in a sentence, honest capital-allocating management, pricing power, low reinvestment needs.

**Peter Lynch — growth you can buy cheaply.** Underfollowed growth stories before the Street piles in. Screens: PEG <1, revenue growth >15%, P/E below the earnings growth rate, genuinely profitable, D/E <0.8, inventory growing slower than sales. Judgment: thin analyst coverage, a strong niche (often in a "boring" industry), a product a normal person understands, insider buying, and buybacks.

**Stanley Druckenmiller — concentrated macro momentum.** Big bets on his best ideas, riding a trend, cutting losers fast. Screens: relative strength vs sector and market over 3–6 months, rising consensus estimates, the sector ETF beating the market, sequential revenue acceleration, RSI ~50–70 (strong, not blown-out). Judgment: a clear secular or policy tailwind, asymmetric payoff, management beating guidance and expanding margins, a cycle position that favors the sector, conviction high enough to size up.

**George Soros — reflexivity and macro imbalance.** Hunt the self-reinforcing loop before it snaps. Screens: valuation at a historical extreme (e.g. CAPE), widening/tightening credit spreads, sharp FX moves, price-vs-fundamentals divergence, volume confirming the narrative. Judgment: a feedback loop (rising prices begetting more buying), a consensus narrative starting to turn, policy shifts that create or kill the dynamic, crowded positioning ripe for reversal, a gap between perception and reality.

**Ray Dalio — risk parity across the cycle.** Diversify across uncorrelated return streams; know where you sit in the long-term debt cycle. Screens: low or negative cross-asset correlations, real yields, debt-cycle gauges (debt/GDP, credit growth, coverage), risk-adjusted returns and drawdown, a balance of growth- and inflation-sensitive assets. Judgment: which debt-cycle phase you're in, paradigm-shift signals, the central bank's trajectory and constraints, geopolitical capital-flow risks, the closest historical analogue.

**Bill Ackman — quality franchises, temporarily mispriced.** Great businesses the market has soured on, with a path to fix the discount. Screens: FCF yield >7%, ROIC >15%, debt/EBITDA <3x, gross margin >50%, trading 30%+ below intrinsic value, a stable-to-growing revenue base. Judgment: room for operational improvement, a misunderstanding that's temporary (not structural), a concrete catalyst (management change, spin-off, strategic review), high barriers to entry, durable demand.

**Michael Burry — deep value, contrarian, early.** Buy what nobody wants, below liquidation value. Screens: P/B <1, P/E <10, asset-heavy balance sheet under liquidation value, EV/EBIT <8, net-current-asset value above market cap (Graham net-net), positive FCF despite depressed earnings. Judgment: an out-of-favor or trough sector, ignored small caps with no coverage, a distressed situation with an identifiable catalyst, a market pricing permanent impairment where recovery is plausible, insiders buying the dip.

**Cathie Wood — disruptive innovation.** Technologies on exponential curves where cost declines create winner-take-most. Screens: a TAM compounding >20%, revenue growth >25%, R&D >15% of revenue, gross margin high and stable/expanding (>50%), rising revenue-per-employee, share gains vs incumbents. Judgment: a platform that spawns many applications, Wright's-Law cost curves, friendly or neutral regulation, converging technologies amplifying each other, a first/strong-second-mover position, management willing to trade near-term profit for the long game.

## Backtesting — temporal integrity is non-negotiable

A leaky backtest is worse than no backtest, because it manufactures false confidence.

- **Censor gap.** Put a gap (default one trading day) between the data cutoff and the evaluation window — financials report with a lag.
- **No lookahead.** Compute returns strictly from prices *after* the censored decision point. Never build a past portfolio with future prices, earnings, or revisions.
- **Stop if you can't verify the gap.** If you can't confirm the censor window holds, halt and tell the user rather than ship a leaky result.

## Gotchas

- **Survivorship bias** — screeners only see currently-listed names. A screen run over a past period silently drops the delisted and bankrupt, inflating apparent returns.
- **Stale financials near earnings** — statement data is the last filed period; days before a release it can be a quarter old and badly off for fast-changing names.
- **ETF holdings lag** — constituent data can trail 30–90 days; recent adds, drops, and rebalances may be missing.
- **Adjusted vs raw prices** — price history is usually split/dividend-adjusted; raw comparisons to historical targets or news-quoted prices will mismatch.
- **Correlations shift** — correlations measured in calm markets understate drawdown risk; they spike toward 1.0 in stress, exactly when you were counting on diversification.

End every investment-research deliverable with: *This is research and analysis, not personalized financial advice. Talk to a qualified advisor before acting on it.*
