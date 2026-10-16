---
recorded: 2026-10-15T00:10:18Z
incident_date: 2026-10-14
---
# Give every time-boxed grant an end date the account can see and a warning before it ends

**Rule:** A trial, a contract term, or any expiring override must be visible to the account with its end date (`GET /v1/billing/account-state` `trial`, `contract`, `grace`), must warn the billing managers and Kortix sales before it ends (`runAccessSweep`: 7/3/1 days for a trial, 30/7/1 for a contract), and must never cut sign-in at the end: SSO and SCIM stay on for 14 days (`ACCESS_GRACE_DAYS`). Enterprise is set only through a contract or a trial, never by a raw tier or flag write; fix a lapsed account through the audited admin routes, never with SQL.

**Trigger surface:** Adding a plan state, a trial kind, an expiring entitlement override, or any code path that ends paid access (`resolve-billing.ts`, `trial-admin.ts`, `enterprise-contracts.ts`, `access-notices.ts`).

**Incident:** 2026-10-14. An enterprise customer's 30-day admin-granted Enterprise trial ended silently. The account fell to Free for about 23 minutes: managed models off, credit purchases off, while a separate `enterprise_entitled` flag kept SSO on — half Enterprise, half Free. Nobody was warned before the end. The repair was a raw production DB write of `tier='enterprise'`, which left no audit event. Fixed on branch `enterprise-plans` (one plan system: contracts, dated trials with warnings and an SSO grace, the flags removed).

**Enforcement:** `unit-resolve-billing.test.ts` ("SSO/SCIM grace after an Enterprise trial"), `unit-trial-admin-grants.test.ts`, flows `ADM-13` (contract lifecycle, grace after the end) and `ADM-16` (the trial is visible in account-state), `plan-card.test.ts` ("Enterprise without a contract on file never reads 'No subscription'"), and `integration-access-notices` (warnings sent once per threshold).
