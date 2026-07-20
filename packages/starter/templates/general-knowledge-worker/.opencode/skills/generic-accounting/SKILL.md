---
name: generic-accounting
description: "Generic starter template — end-to-end accounting and finance-ops methodology: journal entry preparation, month-end close management, account reconciliation, variance analysis, GAAP financial statement presentation, and SOX 404 audit support."
defaultProjectInstall: true
---

> **TODO — make this yours.** This is a generic starting template. Edit it to fit your own accounting operation: your GAAP/IFRS basis, your close calendar and deadlines, your ERP/GL and reconciliation systems, and your materiality thresholds and approval matrix. Delete what you don't use.

# Accounting

End-to-end accounting and finance-ops methodology covering journal entry preparation, month-end close management, account reconciliation, variance analysis, GAAP financial statement presentation, and SOX 404 audit support.

## Journal Entry Preparation

### Standard Accrual Types and Their Entries

**Accounts Payable Accruals** — accrue for goods or services received but not yet invoiced at period end.
- Typical entry: Debit Expense account (or capitalize if asset-qualifying) / Credit Accrued liabilities
- Sources: open purchase orders with confirmed receipts, contracts with services rendered but unbilled, recurring vendor arrangements (utilities, subscriptions, professional services), employee expense reports submitted but not yet processed
- Key considerations: reverse in the following period (auto-reversal recommended); use consistent estimation methodology period over period; document basis for estimates (PO amount, contract terms, historical run-rate); track actual vs accrual to refine future estimates

**Fixed Asset Depreciation** — book periodic depreciation expense for tangible and intangible assets.
- Typical entry: Debit Depreciation/amortization expense (by department or cost center) / Credit Accumulated depreciation/amortization
- Methods: Straight-line = (Cost − Salvage) / Useful life (most common for financial reporting); Declining balance = accelerated method applying fixed rate to net book value; Units of production = based on actual usage or output vs total expected
- Key considerations: run depreciation from the fixed asset register or schedule; verify new additions are set up with correct useful life and method; check for disposals or impairments requiring write-off; ensure consistency between book and tax depreciation tracking

**Prepaid Expense Amortization** — amortize prepaid expenses over their benefit period.
- Typical entry: Debit Expense account (insurance, software, rent, etc.) / Credit Prepaid expense
- Common categories: insurance premiums (typically 12-month policies), software licenses and subscriptions, prepaid rent, prepaid maintenance contracts, conference and event deposits
- Key considerations: maintain an amortization schedule with start/end dates and monthly amounts; review for any prepaid items that should be fully expensed (immaterial amounts); check for cancelled/terminated contracts requiring accelerated amortization; verify new prepaids are added to the schedule promptly

**Payroll Accruals** — accrue compensation and related costs for the period.
- Salary accrual (pay periods not aligned with month-end): Debit Salary expense (by department) / Credit Accrued payroll
- Bonus accrual: Debit Bonus expense (by department) / Credit Accrued bonus
- Benefits accrual: Debit Benefits expense / Credit Accrued benefits
- Payroll tax accrual: Debit Payroll tax expense / Credit Accrued payroll taxes
- Key considerations: calculate salary accrual based on working days in the period vs pay period; bonus accruals should reflect plan terms (target amounts, performance metrics, payout timing); include employer-side taxes and benefits (FICA, FUTA, health, 401k match); track PTO/vacation accrual liability if required by policy or jurisdiction

**Revenue Recognition** — recognize revenue based on performance obligations and delivery.
- Recognize previously deferred revenue: Debit Deferred revenue / Credit Revenue
- Recognize revenue with new receivable: Debit Accounts receivable / Credit Revenue
- Defer revenue received in advance: Debit Cash / Accounts receivable / Credit Deferred revenue
- Key considerations: follow the ASC 606 five-step framework for contracts with customers — identify distinct performance obligations, determine transaction price (including variable consideration), allocate transaction price to performance obligations, recognize revenue as/when performance obligations are satisfied; maintain contract-level detail for audit support

### Supporting Documentation Requirements

Every journal entry should have:
1. **Entry description/memo** — clear, specific description of what the entry records and why
2. **Calculation support** — how amounts were derived (formula, schedule, source data reference)
3. **Source documents** — reference to underlying transactions/events (PO numbers, invoice numbers, contract references, payroll register)
4. **Period** — the accounting period the entry applies to
5. **Preparer identification** — who prepared the entry and when
6. **Approval** — evidence of review and approval per the authorization matrix
7. **Reversal indicator** — whether the entry auto-reverses and the reversal date

### Review and Approval Workflows

Typical approval matrix (thresholds should be set based on your organization's materiality and risk tolerance):

| Entry Type | Amount Threshold | Approver |
|-----------|-----------------|----------|
| Standard recurring | Any amount | Accounting manager |
| Non-recurring / manual | < $50K | Accounting manager |
| Non-recurring / manual | $50K – $250K | Controller |
| Non-recurring / manual | > $250K | CFO / VP Finance |
| Top-side / consolidation | Any amount | Controller or above |
| Out-of-period adjustments | Any amount | Controller or above |

Review checklist before approving a journal entry:
- [ ] Debits equal credits (entry is balanced)
- [ ] Correct accounting period (not posting to a closed period)
- [ ] Account codes exist and are appropriate for the transaction
- [ ] Amounts are mathematically accurate and supported by calculations
- [ ] Description is clear, specific, and sufficient for audit purposes
- [ ] Department/cost center/project coding is correct
- [ ] Treatment is consistent with prior periods and accounting policies
- [ ] Auto-reversal is set appropriately (accruals should reverse)
- [ ] Supporting documentation is complete and referenced
- [ ] Entry amount is within the preparer's authority level
- [ ] No duplicate of an existing entry
- [ ] Unusual or large amounts are explained and justified

### Common Errors to Check For

1. Unbalanced entries — debits do not equal credits (system should prevent, but check manual entries)
2. Wrong period — entry posted to an incorrect or already-closed period
3. Wrong sign — debit entered as credit or vice versa
4. Duplicate entries — same transaction recorded twice
5. Wrong account — entry posted to incorrect GL account (especially similar account codes)
6. Missing reversal — accrual entry not set to auto-reverse, causing double-counting
7. Stale accruals — recurring accruals not updated for changed circumstances
8. Round-number estimates — suspiciously round amounts that may not reflect actual calculations
9. Incorrect FX rates — foreign currency entries using wrong exchange rate or date
10. Missing intercompany elimination — entries between entities without corresponding elimination
11. Capitalization errors — expenses that should be capitalized, or capitalized items that should be expensed
12. Cut-off errors — transactions recorded in the wrong period based on delivery or service date

## Month-End Close Management

### Month-End Close Checklist

**Pre-Close (last 2-3 business days of the month):**
- [ ] Send close calendar and deadline reminders to all contributors
- [ ] Confirm cut-off procedures with AP, AR, payroll, and treasury
- [ ] Verify all sub-systems are processing normally (ERP, payroll, banking)
- [ ] Complete preliminary bank reconciliation (all but last-day activity)
- [ ] Review open purchase orders for potential accrual needs
- [ ] Confirm payroll processing schedule aligns with close timeline
- [ ] Collect information for any known unusual transactions

**Close Day 1 (T+1):**
- [ ] Confirm all sub-ledger modules have completed period-end processing
- [ ] Run AP accruals for goods/services received but not invoiced
- [ ] Post payroll entries and payroll accrual (if pay period straddles month-end)
- [ ] Record cash receipts and disbursements through month-end
- [ ] Post intercompany transactions and confirm with counterparties
- [ ] Complete bank reconciliation with final bank statement
- [ ] Run fixed asset depreciation
- [ ] Post prepaid expense amortization

**Close Day 2 (T+2):**
- [ ] Complete revenue recognition entries and deferred revenue adjustments
- [ ] Post all remaining accrual journal entries
- [ ] Complete AR subledger reconciliation
- [ ] Complete AP subledger reconciliation
- [ ] Record inventory adjustments (if applicable)
- [ ] Post FX revaluation entries for foreign currency balances
- [ ] Begin balance sheet account reconciliations

**Close Day 3 (T+3):**
- [ ] Complete all balance sheet reconciliations
- [ ] Post any adjusting journal entries identified during reconciliation
- [ ] Complete intercompany reconciliation and elimination entries
- [ ] Run preliminary trial balance and income statement
- [ ] Perform preliminary flux analysis on income statement
- [ ] Investigate and resolve material variances

**Close Day 4 (T+4):**
- [ ] Post tax provision entries (income tax, sales tax, property tax)
- [ ] Complete equity roll-forward (stock compensation, treasury stock)
- [ ] Finalize all journal entries — soft close
- [ ] Generate draft financial statements (P&L, BS, CF)
- [ ] Perform detailed flux analysis and prepare variance explanations
- [ ] Management review of financial statements and key metrics

**Close Day 5 (T+5):**
- [ ] Post any final adjustments from management review
- [ ] Finalize financial statements — hard close
- [ ] Lock the period in the ERP/GL system
- [ ] Distribute financial reporting package to stakeholders
- [ ] Update forecasts/projections based on actual results
- [ ] Conduct close retrospective — identify process improvements

### Task Sequencing and Dependencies

```
LEVEL 1 (No dependencies — can start immediately at T+1):
├── Cash receipts/disbursements recording
├── Bank statement retrieval
├── Payroll processing/accrual
├── Fixed asset depreciation run
├── Prepaid amortization
├── AP accrual preparation
└── Intercompany transaction posting

LEVEL 2 (Depends on Level 1 completion):
├── Bank reconciliation (needs: cash entries + bank statement)
├── Revenue recognition (needs: billing/delivery data finalized)
├── AR subledger reconciliation (needs: all revenue/cash entries)
├── AP subledger reconciliation (needs: all AP entries/accruals)
├── FX revaluation (needs: all foreign currency entries posted)
└── Remaining accrual JEs (needs: review of all source data)

LEVEL 3 (Depends on Level 2 completion):
├── All balance sheet reconciliations (needs: all JEs posted)
├── Intercompany reconciliation (needs: both sides posted)
├── Adjusting entries from reconciliations
└── Preliminary trial balance

LEVEL 4 (Depends on Level 3 completion):
├── Tax provision (needs: pre-tax income finalized)
├── Equity roll-forward
├── Consolidation and eliminations
├── Draft financial statements
└── Preliminary flux analysis

LEVEL 5 (Depends on Level 4 completion):
├── Management review
├── Final adjustments
├── Hard close / period lock
├── Financial reporting package
└── Forecast updates
```

**Critical path:** Cash/AP/AR entries → Subledger reconciliations → Balance sheet recs → Tax provision → Draft financials → Management review → Hard close

To shorten the close: automate Level 1 entries (depreciation, prepaid amortization, standard accruals); pre-reconcile accounts during the month (continuous reconciliation); parallel-process independent reconciliations; set clear deadlines with consequences for late submissions; use standardized templates to reduce reconciliation prep time.

### Status Tracking and Reporting

Track each close task with: Task, Owner, Deadline, Status (Not Started / In Progress / Complete / Blocked / At Risk), Blocker, Notes.

Hold a brief (15-minute) daily close standup during the close period: review status board and flag tasks behind; identify blockers; reassign or escalate; update timeline if any tasks are at risk.

Close metrics to track over time:

| Metric | Definition | Target |
|--------|-----------|--------|
| Close duration | Business days from period end to hard close | Reduce over time |
| # of adjusting entries after soft close | Entries posted during management review | Minimize |
| # of late tasks | Tasks completed after their deadline | Zero |
| # of reconciliation exceptions | Reconciling items requiring investigation | Reduce over time |
| # of restatements / corrections | Errors found after close | Zero |

### Typical 5-Day Close Calendar

| Day | Key Activities | Responsible |
|-----|---------------|-------------|
| T+1 | Cash entries, payroll, AP accruals, depreciation, prepaid amortization, intercompany posting | Staff accountants, payroll |
| T+2 | Revenue recognition, remaining accruals, subledger reconciliations (AR, AP, FA), FX revaluation | Revenue accountant, AP/AR, treasury |
| T+3 | Balance sheet reconciliations, intercompany reconciliation, eliminations, preliminary trial balance, preliminary flux | Accounting team, consolidation |
| T+4 | Tax provision, equity roll-forward, draft financial statements, detailed flux analysis, management review | Tax, controller, FP&A |
| T+5 | Final adjustments, hard close, period lock, reporting package distribution, forecast update, retrospective | Controller, FP&A, finance leadership |

### Accelerated Close (3-Day Target)

| Day | Key Activities |
|-----|---------------|
| T+1 | All JEs posted (automated + manual), all subledger reconciliations, bank reconciliation, intercompany reconciliation, preliminary trial balance |
| T+2 | All balance sheet reconciliations, tax provision, consolidation, draft financial statements, flux analysis, management review |
| T+3 | Final adjustments, hard close, reporting package, forecast update |

Prerequisites: automated recurring journal entries (depreciation, amortization, standard accruals); continuous reconciliation during the month (not all at month-end); automated intercompany elimination; pre-close activities completed before month-end (cut-off, accrual estimates); empowered team with clear ownership and minimal handoffs; real-time or near-real-time sub-system integration.

### Close Process Improvement

| Bottleneck | Root Cause | Solution |
|-----------|-----------|---------|
| Late AP accruals | Waiting for department spend confirmation | Implement continuous accrual estimation; set cut-off deadlines |
| Manual journal entries | Recurring entries prepared manually each month | Automate standard recurring entries in the ERP |
| Slow reconciliations | Starting from scratch each month | Implement continuous/rolling reconciliation |
| Intercompany delays | Waiting for counterparty confirmation | Automate intercompany matching; set stricter deadlines |
| Management review changes | Large adjustments found during review | Improve preliminary review process; empower team to catch issues earlier |
| Missing supporting documents | Scrambling for documentation at close | Maintain documentation throughout the month |

Close retrospective questions: What went well this close that we should continue? What took longer than expected and why? What blockers did we encounter and how can we prevent them? Were there any surprises in the financial results we should have caught earlier? What can we automate or streamline for next month?

## Account Reconciliation

### Reconciliation Types

**GL to Subledger Reconciliation** — compare the general ledger control account balance to the detailed subledger balance.
- Common accounts: accounts receivable (GL control vs AR subledger aging), accounts payable (GL control vs AP subledger aging), fixed assets (GL control vs fixed asset register), inventory (GL control vs inventory valuation report), prepaid expenses (GL control vs prepaid amortization schedule), accrued liabilities (GL control vs accrual detail schedules)
- Process: pull GL balance for the control account as of period end; pull subledger trial balance or detail report as of the same date; compare totals (should match if posting is real-time); investigate any differences (timing of posting, manual entries not reflected, interface errors)
- Common causes of differences: manual journal entries posted to the control account but not reflected in the subledger; subledger transactions not yet interfaced to the GL; timing differences in batch posting; reclassification entries in the GL without subledger adjustment; system interface errors or failed postings

**Bank Reconciliation** — compare the GL cash balance to the bank statement balance.
- Process: obtain the bank statement balance as of period end; pull the GL cash account balance as of the same date; identify outstanding checks (issued but not cleared); identify deposits in transit (recorded in GL but not yet credited by bank); identify bank charges, interest, or adjustments not yet recorded in GL; reconcile both sides to an adjusted balance

Standard format:
```
Balance per bank statement:         $XX,XXX
Add: Deposits in transit            $X,XXX
Less: Outstanding checks           ($X,XXX)
Add/Less: Bank errors               $X,XXX
Adjusted bank balance:              $XX,XXX

Balance per general ledger:         $XX,XXX
Add: Interest/credits not recorded  $X,XXX
Less: Bank fees not recorded       ($X,XXX)
Add/Less: GL errors                 $X,XXX
Adjusted GL balance:                $XX,XXX

Difference:                         $0.00
```

**Intercompany Reconciliation** — reconcile balances between related entities to ensure they net to zero on consolidation.
- Process: pull intercompany receivable/payable balances for each entity pair; compare Entity A's receivable from Entity B to Entity B's payable to Entity A; identify and resolve differences; confirm all intercompany transactions have been recorded on both sides; verify elimination entries are correct for consolidation
- Common causes of differences: transactions recorded by one entity but not the other (timing); different FX rates used by each entity; misclassification (intercompany vs third-party); disputed amounts or unapplied payments; different period-end cut-off practices across entities

### Reconciling Item Categorization

**Category 1 — Timing Differences** (no adjusting entry needed, expected to clear in 1-5 business days): outstanding checks, deposits in transit, in-transit transactions, pending approvals.

**Category 2 — Adjustments Required** (prepare adjusting journal entry): unrecorded bank charges, unrecorded interest, recording errors (wrong amount/account/duplicates), missing entries, classification errors.

**Category 3 — Requires Investigation** (investigate root cause, document findings, escalate if unresolved): unidentified differences, disputed items, aged outstanding items, recurring unexplained differences.

### Aging Analysis for Outstanding Items

| Age Bucket | Status | Action |
|-----------|--------|--------|
| 0-30 days | Current | Monitor — within normal processing cycle |
| 31-60 days | Aging | Investigate — follow up on why item has not cleared |
| 61-90 days | Overdue | Escalate — notify supervisor, document investigation |
| 90+ days | Stale | Escalate to management — potential write-off or adjustment needed |

Aging report format: Item #, Description, Amount, Date Originated, Age (Days), Category, Status, Owner.

Trending: compare total outstanding items to prior period; flag if total reconciling items exceed materiality threshold; flag if number of items is growing period over period; identify recurring items that appear every period (may indicate a process issue).

### Escalation Thresholds

Set thresholds based on your organization's materiality level and risk appetite. Examples are illustrative:

| Trigger | Threshold (Example) | Escalation |
|---------|---------------------|------------|
| Individual item amount | > $10,000 | Supervisor review |
| Individual item amount | > $50,000 | Controller review |
| Total reconciling items | > $100,000 | Controller review |
| Item age | > 60 days | Supervisor follow-up |
| Item age | > 90 days | Controller / management review |
| Unreconciled difference | Any amount | Cannot close — must resolve or document |
| Growing trend | 3+ consecutive periods | Process improvement investigation |

### Reconciliation Best Practices

1. **Timeliness** — complete reconciliations within the close calendar deadline (typically T+3 to T+5 business days after period end)
2. **Completeness** — reconcile all balance sheet accounts on a defined frequency (monthly for material accounts, quarterly for immaterial)
3. **Documentation** — every reconciliation should include preparer, reviewer, date, and clear explanation of all reconciling items
4. **Segregation** — the person who reconciles should not be the same person who processes transactions in that account
5. **Follow-through** — track open items to resolution; do not just carry items forward indefinitely
6. **Root cause analysis** — for recurring reconciling items, investigate and fix the underlying process issue
7. **Standardization** — use consistent templates and procedures across all accounts
8. **Retention** — maintain reconciliations and supporting detail per your organization's document retention policy

## Variance Analysis

### Variance Decomposition Techniques

**Price / Volume Decomposition** — the most fundamental decomposition, used for revenue, cost of goods, and any metric expressible as Price x Volume.

```
Total Variance = Actual - Budget (or Prior)

Volume Effect  = (Actual Volume - Budget Volume) x Budget Price
Price Effect   = (Actual Price - Budget Price) x Actual Volume
Mix Effect     = Residual (interaction term), or allocated proportionally

Verification:  Volume Effect + Price Effect = Total Variance
               (when mix is embedded in the price/volume terms)
```

Three-way decomposition (separating mix):
```
Volume Effect = (Actual Volume - Budget Volume) x Budget Price x Budget Mix
Price Effect  = (Actual Price - Budget Price) x Budget Volume x Actual Mix
Mix Effect    = Budget Price x Budget Volume x (Actual Mix - Budget Mix)
```

Example — Revenue variance: Budget 10,000 units at $50 = $500,000; Actual 11,000 units at $48 = $528,000; Total variance +$28,000 favorable = Volume effect +1,000 units x $50 = +$50,000 (favorable) + Price effect -$2 x 11,000 units = -$22,000 (unfavorable).

**Rate / Mix Decomposition** — used when analyzing blended rates across segments with different unit economics.
```
Rate Effect = Sum of (Actual Volume_i x (Actual Rate_i - Budget Rate_i))
Mix Effect  = Sum of (Budget Rate_i x (Actual Volume_i - Expected Volume_i at Budget Mix))
```
Example — Gross margin variance: Product A 60% margin, Product B 40% margin; Budget mix 50/50 → blended 50%; Actual mix 40% A / 60% B → blended 48%; mix effect explains 2pp of margin compression.

**Headcount / Compensation Decomposition:**
```
Total Comp Variance = Actual Compensation - Budget Compensation

Decompose into:
1. Headcount variance    = (Actual HC - Budget HC) x Budget Avg Comp
2. Rate variance         = (Actual Avg Comp - Budget Avg Comp) x Budget HC
3. Mix variance          = Difference due to level/department mix shift
4. Timing variance       = Hiring earlier/later than planned (partial-period effect)
5. Attrition impact      = Savings from unplanned departures (partially offset by backfill costs)
```

**Spend Category Decomposition** — used for OpEx analysis when price/volume is not applicable:
```
Total OpEx Variance = Actual OpEx - Budget OpEx

Decompose by:
1. Headcount-driven costs    (salaries, benefits, payroll taxes, recruiting)
2. Volume-driven costs       (hosting, transaction fees, commissions, shipping)
3. Discretionary spend       (travel, events, professional services, marketing programs)
4. Contractual/fixed costs   (rent, insurance, software licenses, subscriptions)
5. One-time / non-recurring  (severance, legal settlements, write-offs, project costs)
6. Timing / phasing          (spend shifted between periods vs plan)
```

### Materiality Thresholds and Investigation Triggers

Set thresholds based on: financial statement materiality (typically 1-5% of a key benchmark — revenue, total assets, net income); line item size (larger items warrant lower percentage thresholds); volatility (more volatile items may need higher thresholds to avoid noise); management attention (what level of variance would change a decision?).

| Comparison Type | Dollar Threshold | Percentage Threshold | Trigger |
|----------------|-----------------|---------------------|---------|
| Actual vs Budget | Organization-specific | 10% | Either exceeded |
| Actual vs Prior Period | Organization-specific | 15% | Either exceeded |
| Actual vs Forecast | Organization-specific | 5% | Either exceeded |
| Sequential (MoM) | Organization-specific | 20% | Either exceeded |

*Common practice: 0.5%-1% of revenue for income statement dollar thresholds.*

Investigation priority when multiple variances exceed thresholds: largest absolute dollar variance; largest percentage variance; unexpected direction (opposite to trend/expectation); new variance (item on track now off); cumulative/trending variance (growing each period).

### Narrative Generation for Variance Explanations

Structure:
```
[Line Item]: [Favorable/Unfavorable] variance of $[amount] ([percentage]%)
vs [comparison basis] for [period]

Driver: [Primary driver description]
[2-3 sentences explaining the business reason for the variance, with specific
quantification of contributing factors]

Outlook: [One-time / Expected to continue / Improving / Deteriorating]
Action: [None required / Monitor / Investigate further / Update forecast]
```

Narrative quality checklist — good narratives are:
- [ ] **Specific** — names the actual driver, not just "higher than expected"
- [ ] **Quantified** — includes dollar and percentage impact of each driver
- [ ] **Causal** — explains WHY it happened, not just WHAT happened
- [ ] **Forward-looking** — states whether the variance is expected to continue
- [ ] **Actionable** — identifies any required follow-up or decision
- [ ] **Concise** — 2-4 sentences, not a paragraph of filler

Common anti-patterns to avoid: "Revenue was higher than budget due to higher revenue" (circular); "Expenses were elevated this period" (vague); "Timing" without specifying what was early/late and when it will normalize; "One-time" without explaining what the item was; "Various small items" for a material variance (must decompose further); focusing only on the largest driver and ignoring offsetting items.

### Waterfall Chart Methodology

A waterfall (bridge) chart shows how you get from one value to another through positive and negative contributors.

```
Starting value:  [Base/Budget/Prior period amount]
Drivers:         [List of contributing factors with signed amounts]
Ending value:    [Actual/Current period amount]

Verification:    Starting value + Sum of all drivers = Ending value
```

Text-based waterfall format (when no charting tool is available):
```
WATERFALL: Revenue — Q4 Actual vs Q4 Budget

Q4 Budget Revenue                                    $10,000K
  |
  |--[+] Volume growth (new customers)               +$800K
  |--[+] Expansion revenue (existing customers)      +$400K
  |--[-] Price reductions / discounting               -$200K
  |--[-] Churn / contraction                          -$350K
  |--[+] FX tailwind                                  +$50K
  |--[-] Timing (deals slipped to Q1)                 -$150K
  |
Q4 Actual Revenue                                    $10,550K

Net Variance: +$550K (+5.5% favorable)
```

Bridge reconciliation table complement:

| Driver | Amount | % of Variance | Cumulative |
|--------|--------|---------------|------------|
| Volume growth | +$800K | 145% | +$800K |
| Expansion revenue | +$400K | 73% | +$1,200K |
| Price reductions | -$200K | -36% | +$1,000K |
| Churn / contraction | -$350K | -64% | +$650K |
| FX tailwind | +$50K | 9% | +$700K |
| Timing (deal slippage) | -$150K | -27% | +$550K |
| **Total variance** | **+$550K** | **100%** | |

Waterfall best practices: order drivers from largest positive to largest negative (or logical business sequence); keep to 5-8 drivers maximum, aggregate smaller items into "Other"; verify the waterfall reconciles (start + drivers = end); color-code green/red for favorable/unfavorable in visual charts; label each bar with amount and brief description; include a "Total Variance" summary bar.

### Budget vs Actual vs Forecast Comparisons

| Metric | Budget | Forecast | Actual | Bud Var ($) | Bud Var (%) | Fcast Var ($) | Fcast Var (%) |
|--------|--------|----------|--------|-------------|-------------|---------------|---------------|
| Revenue | $X | $X | $X | $X | X% | $X | X% |
| COGS | $X | $X | $X | $X | X% | $X | X% |
| Gross Profit | $X | $X | $X | $X | X% | $X | X% |

When to use each comparison: **Actual vs Budget** — annual performance measurement, compensation decisions, board reporting (budget set once, typically unchanged); **Actual vs Forecast** — operational management, identifying emerging issues (forecast updated periodically); **Forecast vs Budget** — understanding how expectations have changed since planning; **Actual vs Prior Period** — trend analysis, sequential performance, useful when budget is not meaningful (new business lines, post-acquisition); **Actual vs Prior Year** — YoY growth analysis, seasonality-adjusted comparison.

Forecast accuracy analysis:
```
Forecast Accuracy = 1 - |Actual - Forecast| / |Actual|

MAPE (Mean Absolute Percentage Error) = Average of |Actual - Forecast| / |Actual| across periods
```

Variance trending — track how variances evolve to identify systematic bias: consistently favorable (budget may be too conservative/sandbagging); consistently unfavorable (budget too aggressive or execution issues); growing unfavorable (deteriorating performance or unrealistic targets); shrinking variance (forecast accuracy improving through the year — normal pattern); volatile (unpredictable business or poor forecasting methodology).

## Financial Statement Presentation (GAAP)

### Income Statement

Standard format (classification of expenses by function):
```
Revenue
  Product revenue
  Service revenue
  Other revenue
Total Revenue

Cost of Revenue
  Product costs
  Service costs
Total Cost of Revenue

Gross Profit

Operating Expenses
  Research and development
  Sales and marketing
  General and administrative
Total Operating Expenses

Operating Income (Loss)

Other Income (Expense)
  Interest income
  Interest expense
  Other income (expense), net
Total Other Income (Expense)

Income (Loss) Before Income Taxes
  Income tax expense (benefit)
Net Income (Loss)

Earnings Per Share (if applicable)
  Basic
  Diluted
```

GAAP presentation requirements (ASC 220 / IAS 1): present all items of income and expense recognized in a period; classify expenses either by nature (materials, labor, depreciation) or by function (COGS, R&D, S&M, G&A) — function is more common for US companies; if classified by function, disclose depreciation, amortization, and employee benefit costs by nature in the notes; present operating and non-operating items separately; show income tax expense as a separate line; extraordinary items are prohibited under both US GAAP and IFRS; discontinued operations presented separately, net of tax.

Common presentation considerations: revenue disaggregation (ASC 606 requires disaggregation into categories depicting how nature, amount, timing, and uncertainty of revenue are affected by economic factors); stock-based compensation (classify within functional expense categories with total SBC disclosed in notes); restructuring charges (present separately if material, or include in OpEx with note disclosure); non-GAAP adjustments (clearly label and reconcile to GAAP).

### Balance Sheet

Standard format (classified balance sheet):
```
ASSETS
Current Assets
  Cash and cash equivalents
  Short-term investments
  Accounts receivable, net
  Inventory
  Prepaid expenses and other current assets
Total Current Assets

Non-Current Assets
  Property and equipment, net
  Operating lease right-of-use assets
  Goodwill
  Intangible assets, net
  Long-term investments
  Other non-current assets
Total Non-Current Assets

TOTAL ASSETS

LIABILITIES AND STOCKHOLDERS' EQUITY
Current Liabilities
  Accounts payable
  Accrued liabilities
  Deferred revenue, current portion
  Current portion of long-term debt
  Operating lease liabilities, current portion
  Other current liabilities
Total Current Liabilities

Non-Current Liabilities
  Long-term debt
  Deferred revenue, non-current
  Operating lease liabilities, non-current
  Other non-current liabilities
Total Non-Current Liabilities

Total Liabilities

Stockholders' Equity
  Common stock
  Additional paid-in capital
  Retained earnings (accumulated deficit)
  Accumulated other comprehensive income (loss)
  Treasury stock
Total Stockholders' Equity

TOTAL LIABILITIES AND STOCKHOLDERS' EQUITY
```

GAAP presentation requirements (ASC 210 / IAS 1): distinguish between current and non-current assets and liabilities; current = expected to be realized, consumed, or settled within 12 months (or the operating cycle if longer); present assets in order of liquidity (most liquid first — standard US practice); accounts receivable shown net of allowance for credit losses (ASC 326); property and equipment shown net of accumulated depreciation; goodwill is not amortized — tested for impairment annually (ASC 350); leases recognize right-of-use assets and lease liabilities for operating and finance leases (ASC 842).

### Cash Flow Statement

Standard format (indirect method):
```
CASH FLOWS FROM OPERATING ACTIVITIES
Net income (loss)
Adjustments to reconcile net income to net cash from operations:
  Depreciation and amortization
  Stock-based compensation
  Amortization of debt issuance costs
  Deferred income taxes
  Loss (gain) on disposal of assets
  Impairment charges
  Other non-cash items
Changes in operating assets and liabilities:
  Accounts receivable
  Inventory
  Prepaid expenses and other assets
  Accounts payable
  Accrued liabilities
  Deferred revenue
  Other liabilities
Net Cash Provided by (Used in) Operating Activities

CASH FLOWS FROM INVESTING ACTIVITIES
  Purchases of property and equipment
  Purchases of investments
  Proceeds from sale/maturity of investments
  Acquisitions, net of cash acquired
  Other investing activities
Net Cash Provided by (Used in) Investing Activities

CASH FLOWS FROM FINANCING ACTIVITIES
  Proceeds from issuance of debt
  Repayment of debt
  Proceeds from issuance of common stock
  Repurchases of common stock
  Dividends paid
  Payment of debt issuance costs
  Other financing activities
Net Cash Provided by (Used in) Financing Activities

Effect of exchange rate changes on cash

Net Increase (Decrease) in Cash and Cash Equivalents
Cash and cash equivalents, beginning of period
Cash and cash equivalents, end of period
```

GAAP presentation requirements (ASC 230 / IAS 7): indirect method is most common (start with net income, adjust for non-cash items); direct method is permitted but rarely used (requires supplemental indirect reconciliation); interest paid and income taxes paid must be disclosed (face or notes); non-cash investing and financing activities disclosed separately (e.g., assets acquired under leases, stock issued for acquisitions); cash equivalents = short-term, highly liquid investments with original maturities of 3 months or less.

### Common Period-End Adjustments and Reclassifications

**Adjustments:** accruals (expenses incurred but not yet paid); deferrals (adjust prepaid expenses, deferred revenue, deferred costs); depreciation and amortization; bad debt provision (adjust allowance for credit losses based on aging analysis and historical loss rates); inventory adjustments (write-downs for obsolete/slow-moving/impaired inventory); FX revaluation (revalue foreign-currency-denominated monetary assets/liabilities at period-end rates); tax provision (current and deferred income tax expense); fair value adjustments (mark-to-market investments, derivatives, other fair-value items).

**Reclassifications:** current/non-current (reclassify long-term debt maturing within 12 months to current); contra account netting (net allowances against gross receivables, accumulated depreciation against gross assets); intercompany elimination (eliminate intercompany balances/transactions in consolidation); discontinued operations (reclassify to a separate line item); equity method adjustments (record share of investee income/loss); segment reclassifications (ensure transactions properly classified by operating segment).

### Flux Analysis Methodology

For each line item, calculate: dollar variance (current − prior/budget); percentage variance ((current − prior) / |prior| x 100); basis point change for margins/ratios (1 bp = 0.01%).

Materiality thresholds — common approaches: fixed dollar threshold; percentage threshold; combined (either dollar OR percentage exceeded); scaled by line item size/volatility. Example (adjust for your organization):

| Line Item Size | Dollar Threshold | Percentage Threshold |
|---------------|-----------------|---------------------|
| > $10M | $500K | 5% |
| $1M – $10M | $100K | 10% |
| < $1M | $50K | 15% |

Variance decomposition drivers: volume/quantity effect; rate/price effect; mix effect; new/discontinued items; one-time/non-recurring items; timing effect (shift between periods, not a true run-rate change); currency effect.

Investigation and narrative for each material variance: quantify the variance ($ and %); identify favorable or unfavorable; decompose into drivers using the categories above; provide a narrative explanation of the business reason; assess whether temporary or a trend change; note any actions required (further investigation, forecast update, process change).

## Audit Support (SOX 404 Control Testing)

### SOX 404 Overview

SOX Section 404 requires management to assess the effectiveness of internal controls over financial reporting (ICFR):
1. **Scoping** — identify significant accounts and relevant assertions
2. **Risk assessment** — evaluate the risk of material misstatement for each significant account
3. **Control identification** — document the controls that address each risk
4. **Testing** — test the design and operating effectiveness of key controls
5. **Evaluation** — assess whether any deficiencies exist and their severity
6. **Reporting** — document the assessment and any material weaknesses

### Scoping Significant Accounts

An account is significant if there is more than a remote likelihood that it could contain a material misstatement (individually or in aggregate).

Quantitative factors: account balance exceeds materiality threshold (typically 3-5% of a key benchmark); transaction volume is high, increasing risk of error; account is subject to significant estimates or judgment.

Qualitative factors: complex accounting (revenue recognition, derivatives, pensions); susceptible to fraud (cash, revenue, related-party transactions); prior misstatements or audit adjustments; significant management judgment or estimates; new account or significantly changed process.

### Relevant Assertions by Account Type

| Account Type | Key Assertions |
|-------------|---------------|
| Revenue | Occurrence, Completeness, Accuracy, Cut-off |
| Accounts Receivable | Existence, Valuation (allowance), Rights |
| Inventory | Existence, Valuation, Completeness |
| Fixed Assets | Existence, Valuation, Completeness, Rights |
| Accounts Payable | Completeness, Accuracy, Existence |
| Accrued Liabilities | Completeness, Valuation, Accuracy |
| Equity | Completeness, Accuracy, Presentation |
| Financial Close/Reporting | Presentation, Accuracy, Completeness |

### Design Effectiveness vs Operating Effectiveness

**Design effectiveness** — is the control properly designed to prevent or detect a material misstatement in the relevant assertion? Evaluated through walkthroughs (trace a transaction end-to-end); confirm the control is placed at the right point in the process and addresses the identified risk; performed at least annually, or when processes change.

**Operating effectiveness** — did the control actually operate as designed throughout the testing period? Evaluated through testing (inspection, observation, re-performance, inquiry); requires sufficient sample sizes to support a conclusion; must cover the full period of reliance.

### Sample Selection Approaches

**Random Selection** — default method for transaction-level controls with large populations. Define the population; number each item sequentially; use a random number generator to select sample items; ensure no bias in selection. Advantages: statistically valid, defensible, no selection bias. Disadvantages: may miss high-risk items, requires complete population listing.

**Targeted (Judgmental) Selection** — supplement to random selection for risk-based testing; primary method when population is small or highly varied. Identify items with risk characteristics (high dollar amount, unusual/non-standard transactions, period-end transactions, related-party transactions, manual/override transactions, new vendor/customer transactions); select items matching risk criteria; document rationale for each. Advantages: focuses on highest-risk items. Disadvantages: not statistically representative.

**Haphazard Selection** — when random selection is impractical and population is relatively homogeneous. Select items without any specific pattern or bias; spread selections across the full population period; avoid unconscious bias. Advantages: simple. Disadvantages: not statistically valid, susceptible to unconscious bias.

**Systematic Selection** — when population is sequential and you want even coverage across the period. Calculate the sampling interval (Population size / Sample size); select a random starting point within the first interval; select every Nth item. Example: population of 1,000, sample of 25 → interval of 40; random start item 17 → select items 17, 57, 97, 137, ... Advantages: even coverage, simple to execute. Disadvantages: periodic patterns could bias results.

Sample size guidance:

| Control Frequency | Expected Population | Low Risk Sample | Moderate Risk Sample | High Risk Sample |
|------------------|--------------------|-----------------|--------------------|-----------------|
| Annual | 1 | 1 | 1 | 1 |
| Quarterly | 4 | 2 | 2 | 3 |
| Monthly | 12 | 2 | 3 | 4 |
| Weekly | 52 | 5 | 8 | 15 |
| Daily | ~250 | 20 | 30 | 40 |
| Per-transaction (small pop.) | < 250 | 20 | 30 | 40 |
| Per-transaction (large pop.) | 250+ | 25 | 40 | 60 |

Factors increasing sample size: higher inherent risk in the account/process; control is the sole control addressing a significant risk (no redundancy); prior period control deficiency identified; new control (not tested in prior periods); external auditor reliance on management testing.

### Testing Documentation Standards

Every control test should be documented with:
1. **Control identification** — control number/ID, description (what, by whom, how often), type (manual/automated/IT-dependent manual), frequency, risk and assertion addressed
2. **Test design** — test objective, test procedures, expected evidence, sample selection methodology and rationale
3. **Test execution** — population description and size, sample selection details, results per sample item (pass/fail with evidence examined), exceptions noted with full description
4. **Conclusion** — overall assessment (effective / deficiency / significant deficiency / material weakness), basis for conclusion, impact assessment for exceptions, compensating controls considered
5. **Sign-off** — tester name and date, reviewer name and date

Sufficient evidence includes: screenshots showing system-enforced controls; signed/initialed approval documents; email approvals with identifiable approver and date; system audit logs showing who performed the action and when; re-performed calculations with matching results; observation notes (date, location, observer).

Insufficient evidence: verbal confirmations alone (must be corroborated); undated documents; evidence without identifiable performer/approver; generic system reports without date/time stamps; "per discussion with [name]" without corroborating documentation.

Working paper organization (by control area):
```
SOX Testing/
├── [Year]/
│   ├── Scoping and Risk Assessment/
│   ├── Revenue Cycle/
│   │   ├── Control Matrix
│   │   ├── Walkthrough Documentation
│   │   ├── Test Workpapers (one per control)
│   │   └── Supporting Evidence
│   ├── Procure to Pay/
│   ├── Payroll/
│   ├── Financial Close/
│   ├── Treasury/
│   ├── Fixed Assets/
│   ├── IT General Controls/
│   ├── Entity Level Controls/
│   └── Summary and Conclusions/
│       ├── Deficiency Evaluation
│       └── Management Assessment
```

### Control Deficiency Classification

**Deficiency** — exists when the design or operation of a control does not allow management or employees, in the normal course of their functions, to prevent or detect misstatements on a timely basis. Evaluation factors: likelihood the control failure could result in a misstatement; magnitude of the potential misstatement; whether a compensating control mitigates it.

**Significant Deficiency** — a deficiency, or combination, less severe than a material weakness yet important enough to merit attention by those charged with governance. Indicators: could result in a misstatement more than inconsequential but less than material; more than remote (but less than reasonably possible) likelihood of a material misstatement; deficiency in a key control not fully mitigated by compensating controls; combination of individually minor deficiencies that together represent a significant concern.

**Material Weakness** — a deficiency, or combination, such that there is a reasonable possibility that a material misstatement will not be prevented or detected on a timely basis. Indicators: fraud identified by senior management (any magnitude); restatement of previously issued financial statements to correct a material error; auditor identification of a material misstatement not detected by the company's controls; ineffective audit committee oversight of financial reporting; deficiency in a pervasive control (entity-level, ITGC) affecting multiple processes.

**Deficiency Aggregation** — individual deficiencies not significant alone may be significant in combination: identify all deficiencies in the same process or affecting the same assertion; evaluate whether the combined effect could result in a material misstatement; consider whether deficiencies in compensating controls exacerbate other deficiencies; document the aggregation analysis and conclusion.

**Remediation** — for each identified deficiency: root cause analysis (design gap, execution failure, staffing, training, system issue); remediation plan (specific fix actions); timeline (target completion date); owner (person responsible); validation (how/when the remediated control will be re-tested).

### Common Control Types

**IT General Controls (ITGCs)** — support the reliable functioning of application controls and automated processes.
- Access controls: user access provisioning/de-provisioning, privileged access management, periodic access reviews, password policies, segregation of duties enforcement
- Change management: change requests documented and approved before implementation, tested in non-production before promotion, separation of dev/prod environments, emergency change procedures, post-implementation validation
- IT operations: batch job monitoring, backup and recovery (tested restores), system availability/performance monitoring, incident management, disaster recovery planning and testing

**Manual Controls** — performed by people using judgment, typically review and approval (management review of financials, supervisory approval of JEs above threshold, three-way match verification, account reconciliation prep/review, physical inventory observation, vendor master data change approval, customer credit approval). Key attributes to test: performed by the right person; performed timely; evidence of review exists (signature/initials/email/system log); reviewer had sufficient information; exceptions identified and addressed.

**Automated Controls** — enforced by IT systems without human intervention (system-enforced approval workflows, three-way match automation, duplicate payment detection, credit limit enforcement, automated calculations for depreciation/amortization/interest/tax, system-enforced segregation of duties, input validation, automated reconciliation matching). Testing approach: confirm system configuration enforces the control as intended; if configuration has not changed, one test is typically sufficient for the period (supplemented by ITGC change-management testing); re-test if the system changed.

**IT-Dependent Manual Controls** — manual controls relying on completeness/accuracy of system-generated information (review of a system-generated exception report, aging report reserve assessment, reconciliation using system-generated trial balance data, approval of workflow-identified transactions). Testing approach: test the manual control AND test the completeness/accuracy of the underlying report/data (IPE — Information Produced by the Entity).

**Entity-Level Controls** — broad controls operating at the organizational level affecting multiple processes (tone at the top / code of conduct, risk assessment process, audit committee oversight, internal audit function, fraud risk assessment and anti-fraud programs, whistleblower/ethics hotline, management monitoring of control effectiveness, financial reporting competence, period-end financial reporting process). Significance: can mitigate but typically cannot replace process-level controls; ineffective entity-level controls (especially audit committee oversight and tone at the top) are strong indicators of a material weakness; effective entity-level controls may reduce the extent of testing needed for process-level controls.
