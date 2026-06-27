# Finance Document Review Specialization

Guidance for reviewing finance and investment documents: CIMs, pitch decks, offering memorandums, financial models, investment memos, quarterly/annual reports, and prospectuses.

Apply this guidance throughout all phases of the review workflow.

## Claim Examples

### verify_public_data

**Company financials:**
- "KMB reported revenue of $20.4B in FY2023"
- "The company's net debt was $8.2B as of Q3 2024"
- "Adjusted EBITDA margin expanded 150bps year-over-year"

**Market and industry data:**
- "The global SaaS market is projected to reach $900B by 2030"
- "Company X holds approximately 23% U.S. market share"

**Transaction and deal data:**
- "Microsoft acquired Activision Blizzard for $68.7B in 2023"
- "The acquisition was completed at a 12.5x EV/EBITDA multiple"

**Index and benchmark data:**
- "The S&P 500 returned 26.3% in 2023"
- "The 10-year Treasury yield averaged 4.0% in 2023"

**Credit and ratings:**
- "The company maintains a BBB+ rating from S&P"

### numerical_consistency

**Enterprise value calculations:**
- "Market cap $50B + net debt $10B = EV of $60B" — verify addition
- "EV of $60B / EBITDA of $5B = 12.0x multiple" — verify division

**Bridge and waterfall analyses:**
- "Revenue bridge: Base $100M + pricing $5M + volume $12M + FX ($3M) = $114M" — verify all components sum correctly
- "Sources: Term Loan $500M + Equity $300M = $800M; Uses: Purchase Price $700M + Fees $60M + Cash to BS $40M = $800M" — verify Sources equals Uses

**Growth and CAGR calculations:**
- "Revenue grew from $80M in 2020 to $125M in 2023, a CAGR of 16%" — verify: (125/80)^(1/3) - 1
- "Q3 2024 revenue of $52M represents 8% YoY growth vs. Q3 2023 of $48M" — verify: (52-48)/48

**Margin and ratio calculations:**
- "EBITDA of $150M on revenue of $600M = 25.0% margin" — verify division
- "Net debt of $400M / LTM EBITDA of $150M = 2.7x leverage" — verify division
- "Interest coverage: EBITDA $150M / interest expense $30M = 5.0x" — verify division

**Per-share and dilution calculations:**
- "Net income $200M / diluted shares 50M = EPS of $4.00" — verify division
- "Offer price $45 / LTM EPS $3.00 = 15.0x P/E" — verify division

**Capitalization tables:**
- "Series A: 20%, Series B: 15%, Common: 55%, Option Pool: 10% = 100%" — verify percentages sum to 100%

**Pro forma adjustments:**
- "Reported EBITDA $120M + stock-based comp $15M + restructuring $8M + one-time legal $5M = Adjusted EBITDA $148M" — verify all add-backs sum correctly

## Finance-Specific Error Patterns

These are common errors in finance documents that the review should actively look for. Each pattern describes what to watch for and how to classify it.

### GAAP vs. Non-GAAP Inconsistency
A document switches between GAAP and non-GAAP (adjusted) metrics without labeling which is which, or compares them directly. Example: presenting "EBITDA margin of 25%" in the summary but using GAAP operating income in the detailed financials without reconciliation.
- **Issue type**: `narrative_logic`
- **Typical severity**: `medium` to `high` (depending on whether it misleads the reader's assessment of profitability)

### LTM vs. NTM Confusion
Last-twelve-months and next-twelve-months figures mixed without disclosure. Example: "The company trades at 10x EBITDA" using LTM EBITDA in one section but NTM EBITDA in the valuation section.
- **Issue type**: `narrative_logic`
- **Typical severity**: `medium` (directly affects valuation comparisons)

### Diluted vs. Basic Share Count Mixing
Per-share metrics computed with different share counts across sections. Example: EPS calculated on basic shares (45M) in the financial summary but market cap derived using diluted shares (50M) in valuation.
- **Issue type**: `narrative_logic`
- **Typical severity**: `medium` to `high` (affects per-share valuation and implied pricing)

### Pro Forma vs. Reported Conflation
Reported financials and pro forma (adjusted for acquisitions, divestitures, one-time items) used interchangeably. Example: "Revenue grew 30% YoY" where the current year includes an acquisition but the prior year does not.
- **Issue type**: `narrative_logic`
- **Typical severity**: `high` (misrepresents organic growth trajectory)

### Fiscal Year vs. Calendar Year Mismatch
Data compared across companies or periods using mismatched fiscal years. Example: comparing "Company A FY2023 revenue" (fiscal year ending June 2023) with "Company B FY2023 revenue" (fiscal year ending December 2023) as if they cover the same period.
- **Issue type**: `narrative_logic`
- **Typical severity**: `medium`

### Basis Points vs. Percentage Points Confusion
"Margin improved 50bps" written when the actual change is 50 percentage points, or vice versa. 50bps = 0.50 percentage points, not 50 percentage points.
- **Issue type**: `narrative_logic` if internal inconsistency, `numerical_consistency` if the math doesn't work
- **Typical severity**: `high` (order-of-magnitude error in magnitude of change)

### Gross vs. Net Confusion
Gross revenue vs. net revenue, gross debt vs. net debt, gross margin vs. net margin used without distinction. Example: "Debt of $500M" in one section refers to gross debt, while "Leverage of 2.5x" in another section uses net debt ($400M) without disclosing the difference.
- **Issue type**: `narrative_logic`
- **Typical severity**: `medium`

### Stale Data Presented as Current
Data from a prior period used without dating it. Example: a 2024 pitch deck stating "We have 5,000 customers" when that figure is from 2022 and the current count is different. Look for round numbers, lack of "as of" dates, and figures that don't match the document's own more recent data elsewhere.
- **Issue type**: `narrative_logic`
- **Typical severity**: `medium`

### Sources & Uses Imbalance
In transaction documents, Total Sources must equal Total Uses. Any mismatch is an error.
- **Issue type**: `numerical_consistency`
- **Typical severity**: `high` (fundamental transaction structuring error)

### Cap Table Not Summing to 100%
Ownership percentages across all shareholders/tranches must sum to 100% (pre-money or post-money, but consistently).
- **Issue type**: `numerical_consistency`
- **Typical severity**: `high`

### Contradictory Investment Highlights vs. Risk Factors
"Investment highlights" claims that are directly contradicted by the document's own "risk factors" section or vice versa. Example: highlights tout "dominant #1 market position" while risk factors disclose "intense competitive pressure and recent market share losses."
- **Issue type**: `narrative_logic`
- **Typical severity**: `medium`

### Market Share Exceeding 100%
When a document lists market shares for multiple competitors (including the subject company), the total should not exceed 100%. Often caused by mixing different market definitions or data sources across competitors.
- **Issue type**: `numerical_consistency`
- **Typical severity**: `medium`

### Comparable Company Misclassification
Companies included in a "comparable companies" or "comps" analysis that operate in different industries, geographies, or scale tiers than the subject company, without justification.
- **Issue type**: `narrative_logic`
- **Typical severity**: `medium`

### Aggressive or Unjustified Add-Backs
Pro forma or adjusted EBITDA that includes add-backs which are recurring or questionable rather than truly one-time. Example: adding back "non-recurring restructuring charges" that appear in three consecutive years.
- **Issue type**: `narrative_logic`
- **Typical severity**: `medium` to `high`

### Growth Projections vs. Market Growth Disconnect
Revenue growth projections that far exceed the stated market growth rate without explanation of how the company will gain share. Example: 25% revenue CAGR projected in a market described as growing 3-5% annually, with no discussion of share gains or new market entry.
- **Issue type**: `narrative_logic`
- **Typical severity**: `medium`

## Charts and Tables

Finance documents rely heavily on charts and tables to present data. These are high-value review targets because visual data frequently falls out of sync with the narrative text, and errors in them are easy to introduce but hard to spot.

### Tables

**Cross-check tables against narrative text.** When the text states a figure ("Revenue grew 18% in FY2023"), find the corresponding cell in the financial table and verify they match. Discrepancies between tables and text are `narrative_logic` issues (the document contradicts itself).

**Verify table arithmetic.** Column totals, row totals, subtotals, and "Total" rows should sum correctly from their components. Check that:
- Line items sum to stated subtotals and totals
- Percentage columns correspond to the underlying absolute numbers (e.g., segment as % of total)
- YoY change columns match the difference between the two period columns
- Margins shown in the table match the ratio of the relevant line items

**Check unit consistency.** Tables may switch between thousands, millions, and billions — sometimes within the same table via footnotes (e.g., "$ in millions" header but one row in billions). Flag unit mismatches as `narrative_logic`.

**Common table types and what to verify:**
- **Comps table**: Multiples (EV/EBITDA, P/E) should be derivable from the market data and financials shown. Mean/median calculations should be correct. Check that the subject company is clearly distinguished from comps.
- **Precedent transactions table**: Deal values, dates, and multiples should be verifiable via public records. Verify the mean/median of stated multiples.
- **Sources & Uses**: Total Sources must equal Total Uses. Every line item should be additive.
- **Capitalization table**: Ownership percentages must sum to 100%. Share counts times price should equal stated values.
- **Sensitivity / scenario table**: Axis values should span a reasonable range around the base case. The base case cell should match the base case stated elsewhere in the document. Interpolation between cells should be directionally consistent (e.g., higher growth = higher valuation, not lower).
- **Financial statements**: See Financial Statement Cross-Checks below.

### Charts

**Cross-check chart data against tables and text.** When the same data appears in both a chart and a table or narrative, verify consistency. A bar chart showing 2023 revenue of ~$600M while the table says $480M is a `narrative_logic` issue.

**Verify chart labels and titles.** Chart titles, axis labels, and legends should accurately describe what's shown. A chart titled "Revenue by Segment" that actually shows EBITDA by segment is a `narrative_logic` issue.

**Check visual proportionality.** Bar heights, pie slice sizes, and line positions should be roughly proportional to their stated values. A pie chart where a 15% slice appears larger than a 25% slice, or a bar chart where a $200M bar is taller than a $300M bar, suggests a data or formatting error. Flag as `narrative_logic`.

**Common chart types and what to verify:**
- **Waterfall / bridge charts**: Components should sum to the ending value. Example: a revenue bridge from $400M to $450M should have components that net to +$50M.
- **Pie charts**: Segments must sum to 100%. Labels should match the legend and the underlying data.
- **Stacked bar charts**: Each stack's components should sum to the total bar height/value. Totals across periods should match figures stated in tables or text.
- **Line charts / trend lines**: Data points should match the underlying table values. Trend direction should be consistent with the narrative (don't describe "accelerating growth" over a flattening line).

## Financial Statement Cross-Checks

When the document contains financial statements, verify these accounting identities. Failures are `numerical_consistency` issues.

- **Balance sheet**: Total Assets = Total Liabilities + Total Equity
- **Cash flow tie-out**: Beginning cash + net change in cash from CF statement = ending cash on BS
- **Net income consistency**: Net income on the income statement matches net income on the cash flow statement (starting point for operating cash flows) and flows into retained earnings on the BS
- **Depreciation consistency**: D&A expense on the income statement matches D&A add-back on the cash flow statement
- **Per-share consistency**: Same diluted share count used for EPS, dividends per share, and book value per share within the same period
- **Revenue consistency**: Revenue on the income statement matches revenue referenced in MD&A, segment breakdowns, and geographic breakdowns

## Issue Examples

### verify_public_data
- "KMB revenue $22B in FY2023" but 10-K shows $20.4B (refuted)
- "Microsoft acquired LinkedIn in 2018 for $26.2B" — correct price but actual close was 2016 (refuted)
- "Company X's 2024 Q4 revenue was $45M" but Q4 earnings not yet released (inconclusive)
- "The 10-year Treasury yield was 3.5% at year-end 2023" but Federal Reserve data shows 3.88% (refuted)
- "Company rated A- by S&P" but latest rating action shows BBB+ (refuted)

### numerical_consistency
- "KMB $20B + KVUE $15B = $40B combined" — should be $35B
- "Revenue CAGR of 20% from $100M (2020) to $150M (2023)" — actual CAGR is 14.5%: (150/100)^(1/3) - 1
- "Adjusted EBITDA of $148M" but add-backs ($15M + $8M + $5M) on a $120M base = $148M — correct; however in same document, margin stated as "26%" on $600M revenue — should be 24.7%
- "Sources: $500M + $300M = $800M; Uses: $700M + $60M + $50M = $800M" — Uses actually sum to $810M
- "Series A 20% + Series B 15% + Common 55% + Pool 10%" — sums to 100% but later states founder holds "60% of common" which is 33% of total, contradicting a later reference to "35% founder ownership"

### non_public_info
- Real company name used instead of project code name ("Planet Fitness" when code name is "Project Pluto")
- "Board approved the acquisition at $45/share" in a document circulated before public announcement (MNPI)
- Management projections labeled "Company Case" but presented alongside banker estimates without clear attribution
- Individual executive compensation details in a document shared beyond the compensation committee
- Track changes or comments from prior draft visible in metadata, exposing negotiation history
- "DRAFT — CONFIDENTIAL" watermark left in a version shared with a broader audience
- Internal rate of return targets or fund economics visible in a document shared outside the GP

### narrative_logic
- Executive summary states "consistent double-digit revenue growth" but financial tables show 8%, 6%, 12%, 4% across four years
- Investment highlights tout "dominant #1 market position" while risk factors disclose "significant market share loss over the past two years"
- "Adjusted EBITDA" adds back "non-recurring restructuring" charges for the third consecutive year
- Valuation section uses LTM EBITDA ($150M) for the subject company but NTM EBITDA for comparable companies without disclosure
- Revenue projections show 25% CAGR in a market described as growing 4% annually, with no explanation of expected share gains
- Document dated January 2024 references "full-year 2024 results"

## Severity Calibration

Apply proportionality — the same dollar error has different severity depending on the context.

- **high**: Errors that would affect an investment decision or have legal/regulatory consequences.
  - Materially wrong financials (revenue, EBITDA, net income off by more than 5% of the stated value)
  - Incorrect transaction pricing, valuation multiples, or offer terms
  - MNPI exposure or confidentiality breaches in deal-context documents
  - Sources & Uses that don't balance
  - GAAP/non-GAAP conflation that materially misrepresents profitability
  - Pro forma vs. reported conflation that misrepresents growth
  - Cap table errors

- **medium**: Errors that undermine the document's credibility but may not change the investment conclusion.
  - Internal contradictions between sections (highlights vs. risk factors, different metrics used inconsistently)
  - Calculation errors in supporting analyses (non-headline figures)
  - LTM/NTM or diluted/basic inconsistencies
  - Growth projections disconnected from market growth without justification
  - Stale data without disclosure
  - Comparable company selection issues

- **low**: Cosmetic or formatting issues.
  - Typos in company names, executive names, or labels
  - Formatting inconsistencies in financial tables (units, decimal places, alignment)
  - Minor rounding differences (e.g., $20.0B vs. $20.1B when both round correctly)

## Search Strategy

### SEC Filings (EDGAR)
Use filing type to target the right data:
- **10-K**: Annual financials, segment data, full-year metrics — the primary source for annual claims
- **10-Q**: Quarterly financials, interim data, YTD figures
- **8-K**: Material events (acquisitions, divestitures, leadership changes, earnings releases)
- **DEF 14A** (proxy statement): Executive compensation, board composition, share ownership
- **S-1 / F-1**: IPO prospectus, pre-IPO financials, use of proceeds
- **13-D / 13-G**: Significant ownership stakes

Use `allowed_domains: ["sec.gov"]` when targeting SEC filings specifically.

### Query Formulation
- Always include year: "Kimberly-Clark revenue 2023" not just "Kimberly-Clark revenue"
- Use ticker symbols as alternative queries: "KMB 10-K 2023"
- For specific metrics, name the filing: "Apple 10-K 2023 segment revenue"
- For deal data: "{Company} acquisition press release {year}" or "{Company} 8-K {year}"
- For market data: "{Industry} market size {year} {source}" (e.g., "global SaaS market size 2023 Gartner")
- For benchmarks: "S&P 500 total return 2023" or "10-year Treasury yield December 2023"

### Company Investor Relations
- Try `allowed_domains` with company IR pages: `["investor.apple.com"]`, `["ir.tesla.com"]`
- Earnings releases often have the clearest summary of quarterly/annual metrics
- Investor presentations may confirm guidance, multiples, or strategic claims

### When to Mark Inconclusive Early
- **Private companies**: Limited public data — mark inconclusive after 1-2 search attempts unless the company has filed with the SEC (e.g., for debt offerings)
- **Pre-IPO or pre-announcement data**: If the claim references a period for which data hasn't been publicly released, mark inconclusive immediately
- **Proprietary market data**: Claims citing specific research firms (Gartner, McKinsey, IBISWorld) may not be publicly verifiable — mark inconclusive if the underlying report is paywalled
- **Non-US companies**: Try local exchange filings and English-language press releases, but mark inconclusive if data is only available in local regulatory filings that aren't searchable

## Finance Data Tools

When fact-checking `verify_public_data` claims about publicly traded companies, finance data tools provide structured financial data that is more reliable than web search for standardized metrics.

### Availability Check

At the start of Phase 3, call `list_external_tools(queries=["finance"])` once. If the result contains tools with `source_id="finance"`, call `describe_external_tools(source_id="finance", tool_names=["finance_tickers_lookup", "finance_quotes", "finance_financials", "finance_earnings", "finance_ohlcv_histories"])` and then use the workflow below. If empty or the call fails, skip this section and use web search for all claims.

### When to Use Finance Tools vs. Web Search

**Use finance tools for:**
- Revenue, net income, EPS, margins, EBITDA, cash flow, debt, and other standardized financial statement metrics
- Historical stock prices and market data
- Earnings call transcripts (management guidance, segment KPIs, non-GAAP metrics, beat/miss history)

**Use web search for:**
- SEC filing footnotes (debt maturity schedules, lease obligations, acquisition details)
- Proxy statement data (executive compensation, board composition)
- Market size and industry reports from third parties (Gartner, McKinsey, IBISWorld)
- Index and benchmark returns (S&P 500, Treasury yields)
- Credit ratings
- Private company data
- Transaction details (M&A terms, deal multiples) unless discussed in earnings transcripts

### Workflow

**Step 1: Resolve tickers.** Always call `finance_tickers_lookup` before any other finance tool. Never assume ticker symbols — standard tickers may not resolve correctly.

```
call_external_tool(tool_name="finance_tickers_lookup", source_id="finance", arguments={
    "queries": ["Kimberly-Clark"]
})
```

**Step 2: Determine the reference date.** Use the document's date (headers, footers, "as of" statements) to derive fiscal period parameters:

| Document Reference Month | Fiscal Quarter |
| --- | --- |
| January–March | Q1 |
| April–June | Q2 |
| July–September | Q3 |
| October–December | Q4 |

**Step 3: Fetch data.** Match the claim to the right tool:

| Claim About | Tool | Key Parameters |
| --- | --- | --- |
| Revenue, net income, margins, EPS, debt, cash, capex | `finance_financials` | `ticker_symbols`, `period` ("annual"/"quarter"/"ttm"), `as_of_fiscal_year`, `as_of_fiscal_quarter`, metric lists (`income_statement_metrics`, `balance_sheet_metrics`, `cash_flow_metrics`) |
| Management guidance, non-GAAP metrics, segment KPIs | `finance_earnings` | `ticker_symbol`, `as_of_fiscal_year`, `as_of_fiscal_quarter`, `data_types: ["transcript_processed"]` |
| EPS beat/miss history | `finance_earnings` | `data_types: ["earnings_history"]` |
| Historical stock prices | `finance_ohlcv_histories` | `ticker_symbols`, `query`, `start_date_yyyy_mm_dd`, `end_date_yyyy_mm_dd`, `fields: ["close"]` |

**Step 4: Fall back to web search.** If a finance tool returns no data for a claim, or the claim is outside finance tool scope (see "Use web search for" above), use `web_search` with the Search Strategy guidance above.

### Rules

- Always pass `as_of_fiscal_year` and `as_of_fiscal_quarter` to `finance_financials` and `finance_earnings` — never omit them.
- Always resolve tickers with `finance_tickers_lookup` first.
- All finance tools use `call_external_tool(tool_name="<name>", source_id="finance", arguments={...})`.
- Finance tool calls count toward the Phase 3 parallelism limit (up to 4 tool calls per turn). Combine finance tool calls with `bash` calculations and `web_search` in the same turn when possible.
- If a finance tool returns unexpected or empty results, fall back to web search. Do not retry the same finance tool call more than once.

### Examples

**Verify annual revenue:**

Claim: "KMB reported revenue of $20.4B in FY2023"

```
call_external_tool(tool_name="finance_tickers_lookup", source_id="finance", arguments={
    "queries": ["Kimberly-Clark"]
})
```
```
call_external_tool(tool_name="finance_financials", source_id="finance", arguments={
    "ticker_symbols": ["KMB"],
    "period": "annual",
    "as_of_fiscal_year": 2023,
    "as_of_fiscal_quarter": 4,
    "limit": 1,
    "income_statement_metrics": ["revenue"]
})
```

**Verify non-GAAP metric via earnings transcript:**

Claim: "Adjusted EBITDA margin expanded 150bps year-over-year"

```
call_external_tool(tool_name="finance_earnings", source_id="finance", arguments={
    "ticker_symbol": "KMB",
    "as_of_fiscal_year": 2023,
    "as_of_fiscal_quarter": 4,
    "data_types": ["transcript_processed"]
})
```

Non-GAAP metrics like adjusted EBITDA are typically discussed in earnings calls, not in standardized financial statements.

**Verify stock price change:**

Claim: "The stock price declined 15% in 2023"

```
call_external_tool(tool_name="finance_ohlcv_histories", source_id="finance", arguments={
    "ticker_symbols": ["KMB"],
    "query": "KMB stock price 2023",
    "start_date_yyyy_mm_dd": "2023-01-03",
    "end_date_yyyy_mm_dd": "2023-12-29",
    "fields": ["close"]
})
```

Then use `bash` with `python -c` to calculate the percentage change from the first to last close price.

## Evidence Examples

- verify_public_data: Evidence=["KMB 2023 revenue was $20.4B per 10-K filing dated Feb 2024"], Sources=["web:9"]
- verify_public_data: Evidence=["Microsoft completed LinkedIn acquisition in December 2016 for $26.2B per 8-K filing"], Sources=["web:3"]
- numerical_consistency: Evidence=["CAGR check: (125/80)^(1/3) - 1 = 16.1%, stated 16%, within rounding tolerance"], Sources=[]
- numerical_consistency: Evidence=["Sources sum: $500M + $300M = $800M; Uses sum: $700M + $60M + $50M = $810M, does not match Sources"], Sources=[]

## Output Tone

Frame issues in terms of deal credibility, investment decision impact, and document integrity. Use precise financial language.

Example summary:

"I've completed a comprehensive review of the investment memorandum covering all 47 pages. The review identifies areas where financial figures, calculations, and narrative consistency could be strengthened to improve the document's accuracy and credibility."
