---
recorded: 2026-10-14T09:20:30Z
incident_date: 2026-10-14
---
# Watch the credit balance of every admin-grant-funded enterprise account and grant before it reaches zero: at zero its Apps return 402 app_account_unfunded and every session start and model call returns 402.

**Rule:** Watch the credit balance of every admin-grant-funded enterprise account, and grant before it reaches zero. At zero, its Apps return `402 app_account_unfunded`, and every session start and model call returns `402`.

**Trigger surface:** Running agent-heavy workloads (multi-agent analysis, backtests, many parallel sessions) inside an enterprise customer project whose account has no subscription and no auto-top-up. Admin grants fund such an account.

**Incident:** 2026-10-14, about 08:39 to 09:25 UTC. An enterprise account (no subscription, auto-top-up off, no payment method) went to a negative balance while our own analysis sessions ran. Every model call failed with `APIError: Out of credits`. `kortix sessions start` returned HTTP `402`. The customer's Convex App returned `402 {"code":"app_account_unfunded"}`: its dashboard showed no data and its crons stopped. The customer's own users' sessions were blocked. A platform admin credit grant (`POST /v1/admin/api/accounts/{id}/credits`) fixed it; the App and sessions served again within a minute. Two traps: `kortix billing status` reads the CLI's ACTIVE account, not the linked project's account, although its header prints the project's account. A Convex `env set` issued while the App was unfunded applied later when funds returned, so re-check env after an outage.

**Enforcement:** none yet: build a low-balance alert for admin-grant-funded accounts (threshold plus owner notification) in the billing worker. Until then the operator checks `balanceAfter` from `GET /v1/admin/api/accounts/{id}/ledger?limit=1` on every loop wake.
