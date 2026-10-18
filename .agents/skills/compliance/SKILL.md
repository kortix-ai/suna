---
name: compliance
description: "Customer-facing compliance duties that code runs: the subprocessor list and its automatic 30-day DPA notice, and the audit evidence it leaves. Load WHENEVER you add, remove or change a subprocessor (a new model provider, host, email or analytics vendor), route customer data to a new third party, touch apps/web/.../legal/subprocessors, packages/shared/src/subprocessors.ts or apps/api/src/billing/services/subprocessor-notices.ts, or need proof for an auditor that customers were notified."
---

# Compliance

The Data Processing Addendum (DPA) promises two things that code keeps:

- Section 7.2 / Annex III: `/legal/subprocessors` lists every third party that
  processes customer personal data.
- Section 7.3: a new subprocessor gets at least 30 days' notice before it
  processes customer personal data.

## Add a subprocessor

A new vendor that sees customer data is a subprocessor: a model provider for
Kortix-managed models, a host, an email, log or analytics vendor. A model a
customer reaches with their own key is not one.

1. Sign or accept the vendor's DPA. For an inference vendor, confirm zero data
   retention for our account.
2. Add the row to `packages/shared/src/subprocessors.ts`. Use the vendor's legal
   entity name from its terms. Set `addedOn` to the day the PR merges. Move
   `SUBPROCESSORS_UPDATED` to the same day.
3. Merge to `dev`. The row ships with the next prod release.
4. Send the vendor no customer data before the row's effective date
   (`addedOn` + 37 days). The page shows it as "From <date>".

A change to an existing row (purpose, location) needs no `addedOn` and sends
no email. Removing a vendor needs no notice: delete the row.

## What runs by itself

`runSubprocessorNoticeSweep` (`apps/api/src/billing/services/subprocessor-notices.ts`)
runs hourly in the billing worker, on prod only (`INTERNAL_KORTIX_ENV=prod`).

- A row is open from the first sweep that sees it on prod until its effective
  date. The release has 7 days to reach prod, so every customer gets 30 to 37
  days.
- Each open notice goes once to the owners and admins of every paid account
  (`credit_accounts.tier` not `free` or `none`). Reply-To is
  privacy@kortix.com: a reply is an objection.
- Each notified account gets an audit event `legal.subprocessor_notice.sent`
  (`resource_id` = `addedOn`, `output_summary` = recipient count, effective
  date, vendor names). The customer sees it in the account's audit log.
- privacy@kortix.com gets one report per sweep that sent. Subject "Subprocessor
  notice gave only N days" means the release took more than 7 days: hold the
  vendor until 30 days after that report and move `addedOn`.

## Evidence for an auditor

```sql
select account_id, created_at, output_summary
from kortix.audit_events
where action = 'legal.subprocessor_notice.sent' and resource_id = '<addedOn>'
order by created_at;
```

The privacy@kortix.com reports give the per-sweep totals.

## Tests

`apps/api/src/__tests__/integration-subprocessor-notices.test.ts`:
`pnpm test -- --db-only integration-subprocessor-notices`.
