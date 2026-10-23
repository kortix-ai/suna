---
name: compliance
description: "Customer-facing compliance duties that code runs: the subprocessor list and its automatic 30-day DPA notice, and the audit evidence it leaves. Load WHENEVER you add, remove or change a subprocessor (a new model provider, host, email or analytics vendor), route customer data to a new third party, touch apps/web/.../legal/subprocessors, packages/shared/src/subprocessors.ts or apps/api/src/billing/services/subprocessor-notices.ts, or need proof for an auditor that customers were notified. Load too for staff access to a customer account: act-as impersonation, 'Open as admin', and its audit trail; and for a penetration test report: the status of each finding and the risks Kortix accepts. Load too for the 90-day deletion of a terminated account's data (the retention backstop, kortix.retention_erasures, RETENTION_ERASURE_MODE) and its monthly evidence."
---

# Compliance

The Data Processing Addendum (DPA) promises three things that code keeps:

- Section 7.2 / Annex III: `/legal/subprocessors` lists every third party that
  processes customer personal data.
- Section 7.3: a new subprocessor gets at least 30 days' notice before it
  processes customer personal data.
- The DPA and the Data Retention Policy: a terminated account's personal data
  is deleted within 90 days of the termination (section "Delete a terminated
  account within 90 days").

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
   (`addedOn` + 37 days). The page shows it as "From <date>". Managed-model
   inference is served by Platinum Inference: give the Platinum team the same
   date, and Platinum Inference holds the change back until then.

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

## Delete a terminated account within 90 days

Terminated means closed (decision D6b, 2026-10-14): an open
`kortix.account_deletion_requests` row. `POST /v1/account/request-deletion`
writes it with a 14-day grace; deleting the auth user writes it due now. The
account closes at `scheduled_for`. A plan cancellation, a downgrade to Free, a
payment failure or an idle account is not a termination.

Two workers delete a closed account, both through `runAccountDeletion`
(`apps/api/src/billing/services/account-deletion.ts`):

1. `account-deletion` (every 15 min): a request due within the last 2 days.
2. `retention-erasure` (daily, `apps/api/src/billing/services/retention-erasure.ts`):
   every request still open `RETENTION_ERASURE_AFTER_DAYS` (default 80) after
   `scheduled_for`. It skips an account that still acts live (a paid plan whose
   payment is not cancelled, or a session or turn after the close) and records
   `skipped_live` for a person.

`RETENTION_ERASURE_MODE`: `dry_run` (default) records `would_erase` and
deletes nothing; `execute` deletes; `off` stops the tick.
`ACCOUNT_DELETION_SWEEP_PAUSED=true` forces `dry_run`.

### Monthly evidence

One `kortix.retention_erasures` row per account, UTC day and mode: ids, dates,
outcome, no personal data. It outlives the account.

```sql
select account_id, request_id, requested_at, closed_at, run_on, mode, outcome, error,
       run_on - closed_at::date as days_after_close
from kortix.retention_erasures
where run_on >= date '<YYYY-MM-01>' and run_on < date '<YYYY-MM-01>' + interval '1 month'
order by run_on, account_id;
```

An `erased` row is the proof. A `failed` or `skipped_live` row past day 80 is
an open item for a person: fix the failure, or decide the live account.

Tests: `pnpm test -- --db-only integration-retention-erasure`.

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

## Penetration test findings

The register of third-party pentest findings. One row per finding, with its
status and the evidence. An accepted risk names the reason and the control
that limits it. The report itself stays out of the repository: it holds
tokens and account ids.

### Web app pentest, July 2026 (scope: dev.kortix.com, dev-api.kortix.com)

| # | Finding | Status | Evidence |
|---|---|---|---|
| 1 | BOLA: `GET /v1/billing/account-state` returned the billing state on membership alone (Medium, CVSS 5.3) | Fixed 2026-10-21 | The route returns the money fields only when `authorize` grants `billing.read`. Every other caller gets the gating view (`can_run`, plan, entitlements). Flow `BILL-21`. Since 2026-08-19 every built-in account role holds `billing.read`, so a plain member reading the state is intended. |
| 2 | Account name accepts HTML (Informational) | Fixed 2026-10-21 | `accountNameError` refuses `<`, `>` and control characters on create and rename. Every email template escapes the name (`escapeHtml`). Flow `ACCT-4`. |
| 3 | JWTs signed with HS256 (Informational) | Staging fixed 2026-10-21; prod after the next release | Every hosted project signs user tokens with ES256 since 2026-08-21. 2026-10-21: dev, staging and prod moved to `sb_publishable_` / `sb_secret_` keys with zero downtime (325 probe checks, 0 failures), and the API stopped trusting the legacy secret itself (random `SUPABASE_JWT_SECRET` in every hosted env). Staging: legacy API keys disabled and the HS256 secret revoked; a token forged with the old secret for a real session gets 403 from Supabase and 401 from the API. Prod and dev wait for the mobile app to ship the publishable key. Procedure: `references/supabase-legacy-key-retirement.md`. |
| 4 | Concurrent logins allowed (Informational) | Accepted | Users run the web app, desktop, CLI and mobile at once; a one-session rule breaks that. Controls: account MFA enforcement, SSO enforcement, admins list and revoke any member session (`GET /v1/accounts/:accountId/iam/sessions`, `POST …/iam/sessions/:sessionId/revoke`). |
| 5 | Session cookie without `Secure` (Informational) | Fixed | `apps/web/src/lib/supabase/client.ts` and `server.ts` set `Secure` on HTTPS. HSTS is on at the edge. |
| 6 | Session cookie without `HttpOnly` (Informational) | Accepted | The Supabase browser client reads the session from JavaScript (`client.ts` comment). Controls: React output encoding, server-side input validation (#2), `SameSite=Lax`, short-lived access tokens. Removing it means a server-only session, a separate project. |

