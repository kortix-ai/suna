---
name: compliance
description: "Customer-facing compliance duties that code runs: the subprocessor list and its automatic 30-day DPA notice, Terms of Service changes and their 30-day notice, customer logo use (publicity), and the audit evidence it leaves. Load WHENEVER you add, remove or change a subprocessor (a new model provider, host, email or analytics vendor), route customer data to a new third party, touch apps/web/.../legal/subprocessors, packages/shared/src/subprocessors.ts or apps/api/src/billing/services/subprocessor-notices.ts, the Terms of Service text or packages/shared/src/terms.ts, or need proof for an auditor that customers were notified. Load too for staff access to a customer account: act-as impersonation, 'Open as admin', and its audit trail; and for a penetration test report: the status of each finding and the risks Kortix accepts."
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

## Change the Terms of Service

The text is `apps/web/src/app/[locale]/(public)/(seo)/legal/terms-of-service.ts`.
The version and the notice are `packages/shared/src/terms.ts`.

Terms section 16: a material change needs 30 days' notice to self-serve
customers. A signed Order keeps the Terms version it names.

1. Edit the text. Update the version line at the top of `TERMS_OF_SERVICE`.
2. In `terms.ts`: move `TERMS_PREVIOUS_VERSION` to the old version, set
   `TERMS_VERSION` to the merge day, `TERMS_EFFECTIVE` 37 days later, and
   `TERMS_CHANGES` to one sentence per change.
3. If the change affects what a person accepts at signup, change the
   consent line too (`packages/ui/src/internal/auth/auth-card-shell.tsx`,
   key `auth.customerLogoNotice` for the publicity clause).
4. Merge to `dev`. The notice ships with the next prod release.

`runTermsNoticeSweep` (`apps/api/src/billing/services/terms-notices.ts`) runs
hourly in the billing worker, on prod only. It emails every signed-up user
once, free or paid (`auth.users` with an email, not deleted, not anonymous),
at most 2,000 per sweep. Reply-To is legal@kortix.com. Each sent email leaves
an audit event `legal.terms_notice.sent` (`resource_id` = `TERMS_VERSION`,
`output_summary.user_id`). legal@kortix.com gets one report when every user
has the notice, and one per sweep while it runs late: "Terms notice gave only
N days" means move `TERMS_EFFECTIVE`.

### Customer logos (Terms section 10, from version 2026-10-28)

The clause covers every account on every plan, free plans and trials
included. Kortix may show the name and logo of the customer's organization,
also one known only from a user's email domain, in customer lists. It never
publishes the name of an individual person, and never a quote, case study or
endorsement without written approval. An opt-out arrives at legal@kortix.com:
remove the name and logo from Kortix websites within 30 days. Never use a
logo before `TERMS_EFFECTIVE`, or for a customer whose signed Order excludes
it.

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

