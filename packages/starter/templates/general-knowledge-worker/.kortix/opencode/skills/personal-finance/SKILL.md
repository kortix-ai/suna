---
name: personal-finance
description: "The user's own connected financial accounts: brokerage holdings and positions, portfolio summary and performance, account balances and net worth, bank/credit-card transactions and spending, liabilities (loans, APRs, terms), and self-reported income/risk profile. Use whenever the question is about *their* money — 'what do I own', 'how's my portfolio', 'my balances', 'what did I spend on groceries', 'my debts'. Falls back to general financial guidance via web search when no account is connected."
---

# Personal Finance

> **Requires a Kortix connector (brokerage / account aggregation).** Marketplace skill — install it when the connector is configured. This skill reads **private user data** — holdings, balances, transactions, debts — so handle it with the privacy discipline below.

This skill is about the user's *own* money. For public-market prices and company fundamentals, that's `finance-markets` — keep the two separate.

## Getting the connector

Connected-account data comes from a brokerage or account-aggregation provider reached **through a Kortix connector** — for example a Plaid-style aggregator authorized via Pipedream, or a brokerage you link with an API key. You query it through the connector bridge; don't hardcode any vendor's tool names.

1. **Check what's connected** — list usable connectors (`kortix executor connectors`, or the `connectors` MCP tool). A brokerage/aggregation provider in that list means account data is live.
2. **If none is connected**, set it up in the same turn: mint a connect link (`connect` tool, or `kortix executor connect <slug>`; add it first with `add_connector` / `kortix executor add <slug> --provider pipedream --app <app>` if it's not on the project yet) for an OAuth provider, or a secret link (`request_secret`) for an API-key provider. Surface the URL with a one-line "what this connects", end your turn, and verify on return.
3. **If a query comes back "auth required"**, surface the connect step to the user — never paper over it with made-up holdings or balances.

> **No account connected?** Still useful. Answer general personal-finance questions — budgeting, debt-payoff strategy, what a 401(k) or an index fund is, how to think about an emergency fund — from web search and reasoning. Just never present fabricated *account* figures as if they were the user's real data.

## What you can read

- **Holdings / positions** — ticker, quantity, price, value, day change, gain/loss.
- **Portfolio summary** — total value, day change, aggregate gain/loss, notable positions.
- **Balances** — cash and balances across bank, card, loan, and brokerage accounts; net worth.
- **Transactions** — search, filter, and aggregate bank and card activity (spending, payments).
- **Liabilities** — loans and cards with rates, APRs, terms, and overdue flags.
- **Profile** — self-reported income bracket and risk comfort; load this when tailoring any advice or recommendation to the user.

## Privacy discipline

Private financial values are sensitive by default. The platform can mask them, redact them on a shared thread, and render them as account-aware pills — but only if you mark every private value as private when you present it. An interactive answer that shows holdings, balances, transactions, or liabilities as raw, unmarked numbers is a failure: unmarked values can't be masked and leak the moment the thread is shared.

- **Mark every private value you present as private — including every numeric cell in every table** (quantity, price, value, weight, gain, APR, balance). Tables are the number-one place this gets dropped; don't.
- **Tie each value to its provenance** — which account/institution, which masked account number, and the as-of date it was pulled. That account+mask+value trail is the proof the number is real.
- **Derived values show their work** — a portfolio weight, a category spend total, an unrealized-gain sum should record the formula and the inputs behind it.
- **Prefer the provider's own aggregates** — when you need a total or a grouped breakdown, ask the connector to group/aggregate and cite the returned aggregate row, rather than summing hundreds of line items locally.
- **Only mark what you present.** Skip pure intermediates; but in any table or summary, "what you present" means every cell.
- **Never fabricate, never narrate the plumbing.** Don't invent a value to fill a gap, and don't describe the masking machinery in your reply — talk about what the numbers mean.

Note on quieter surfaces: scheduled notifications and emails may not render rich masking. There, print the plain value with its institution/mask/as-of label — and never *suppress* a real tool-sourced figure just because the rich rendering isn't available.

## Portfolio composition analysis

When the user wants their portfolio understood, not just listed:

- **Concentration** — each position's weight (`position_value / total_value`) and an HHI to gauge how lopsided it is. Flag any single name above ~20%.
- **Allocation** — weights by sector, asset class, and account; flag any sector above ~40%.
- **Risk** — pull price history for the holdings (via `finance-markets`) and compute portfolio beta, annualized volatility, and pairwise correlations; flag pairs above ~0.8 (diversification you think you have but don't).
- **Valuation** — weighted-average P/E, P/S, P/B vs market averages, to show whether the book is expensive or cheap overall.
- **Spending** — for transaction questions, group by category and period, surface the trend, and call out the outliers.

Mark every figure in the output as private and tie it to the holding or account it came from.

## Output

Lead with the answer, then the supporting table. A holdings view: ticker, value, weight, day change, gain/loss — every cell marked private. A spending view: category, total, share of spend, vs prior period. Always state the as-of date, and pair raw values with context (a weight next to a value, a category next to its share of the total).

## Gotchas

- **Auth before fabrication** — an "auth required" response means connect, not invent.
- **Aggregate at the source** — for totals and grouped breakdowns, use the connector's aggregation and cite the aggregate row; long local sums lose provenance and large derivation chains get truncated.
- **Scope** — public prices, company fundamentals, and "is this stock a buy" are `finance-markets` / `investment-research`. This skill is strictly the user's connected accounts and general money guidance.
