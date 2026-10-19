---
name: compliance
description: "Customer-facing compliance duties that code runs: the subprocessor list and its automatic 30-day DPA notice, and the audit evidence it leaves. Load WHENEVER you add, remove or change a subprocessor (a new model provider, host, email or analytics vendor), route customer data to a new third party, touch apps/web/.../legal/subprocessors, packages/shared/src/subprocessors.ts or apps/api/src/billing/services/subprocessor-notices.ts, or need proof for an auditor that customers were notified. Load too for staff access to a customer account: act-as impersonation, 'Open as admin', and its audit trail."
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

## Staff access to a customer account (act-as)

A platform admin enters a customer account only through an act-as grant
(`kortix.impersonation_grants`, `apps/api/src/shared/impersonation.ts`). There
is no other door: the read-only `x-kortix-admin-bypass` header was retired on
2026-10-19 and the API ignores it.

- Two entry points, one grant: Admin → Accounts → Open as account
  (`{account_id}`), and "Open as admin" on a project's access screen
  (`{project_id}`; the API resolves the project's account).
- A grant lives at most 1 hour. The web app shows a banner while it is live.
  Exit revokes it. A new grant revokes the one it replaces.
- Inside the grant the operator acts as the account owner and holds session
  oversight: a member's private session opens. Routes that create access
  outliving the grant (tokens, members, SSO, shares, connections) answer 403.
- The customer's audit log records `admin.impersonate.start`, `.stop`, one
  `admin.impersonate.action` per write, and
  `project.admin_oversight_session_read` the first time each private session
  opens in an hour (per API task).

```sql
select created_at, action, actor_user_id, metadata
from kortix.audit_events
where account_id = '<account_id>' and action like 'admin.impersonate.%'
order by created_at desc;
```

Contract: flows `IMP-1` and `IMP-2` (`pnpm test -- --id IMP-2`).
