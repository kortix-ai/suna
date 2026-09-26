---
recorded: 2026-09-01T19:20:07Z
incident_date: 2026-09-01
commit: 4b6e5ba982
---
# A floor that refuses a DEBIT stops the bookkeeping, not the spending

**When:** writing anything that moves money after work has been performed —
a usage settlement, a metering debit, a post-hoc reconciliation. Two different
questions were being answered by one function:

  ADMISSION  — "may this account START work?"   strict floor, never negative
  SETTLEMENT — "record work already DONE"       must always succeed

`atomic_use_credits` refuses any debit that would go below zero. Correct for
admission; for settlement it deletes the RECORD of spend that already happened,
because refusing it does not un-spend the money. Compounded by
`subscriptionBypassesWalletFloor`, which exempted any paying per-seat /
credit-plan / paid-tier account from the floor entirely — added to fix a COPY
bug ("Your team isn't on a plan yet" shown to a paying Team account), by
removing metering instead of fixing the words.

Measured on one 6-seat account: `grantForSeats(6)` = $150/mo included usage,
wallet $0.00, `credit_ledger` $588.81, and the gate admitting every create /
start / wake / prompt / gateway call. Past $0 every debit returned
`success:false`, no ledger row was written, and "Spent this period" — which
SUMs `credit_ledger` — silently froze while compute kept burning.

**Rules.** (1) Never let a balance floor gate a settlement; overdraft instead,
and let the NEXT admission refuse — recording the debt blocks the account
harder than losing it did. (2) A failed settlement is unrecorded revenue: log
it at `error` with the account, never `warn`, and never `.catch(() => {})`.
(3) Fixing wrong COPY by widening a spend permission is never the smaller
change. (4) Any client surface that turns a balance into a decision must read
the state machine, not the number — `billing-gate-state.ts` had carried a
docblock naming that exact defect ("the sidebar keyed off the raw balance")
since PR #5141 and it shipped again anyway, because prose enforces nothing.

**Diagnostic:** a wallet at exactly $0.00 on an account that plainly still
works is this. Confirm by summing `credit_ledger` for the period against the
account's grant: if spend exceeds the grant and the balance is pinned at zero,
the ledger stopped recording rather than the account stopping.

*Incident:* no outage; revenue under-collected and finance reporting blind for
one billing period on every drained per-seat account. Fixed in PR #7080.
*Enforcer:* `billing-source-rules.test.ts` (three source-level tripwires: no
balance-to-number decisions outside the decision layer, no billing prose in
components, the bypass stays deleted on both sides of the wire);
`billing-state.test.ts` sweeps every Stripe status x plan class against the
universal floor; `tests/migration/wallet-ledger.test.ts` pins the settlement
contract (`wallet.settle`) against real PostgreSQL.
