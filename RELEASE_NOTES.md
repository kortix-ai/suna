Per-account session-limit override + session delete/provision race fix

This release ships two changes:

**1. Per-account concurrent-session override** (`f162d38289`)
Concurrent-session caps were tier-only. Adds an operator-set per-account
override (`credit_accounts.max_concurrent_sessions`; NULL = tier decides,
a positive integer wins over the tier in both directions) and a clearer
429 message that includes the account's actual limit. Wired through
session-create enforcement, trigger backpressure, and the billing
account-state response.

**2. Session-delete-mid-provision resurrection race fix** (this promotion's
second change)
A session deleted while its sandbox was still provisioning could come back
to life: the fire-and-forget provisioner had no status guards on its
finish-of-provisioning writes, so a session deleted mid-provision could be
flipped back to 'running' (and billed) after the user had already deleted
it. Both finish-of-provisioning writes are now conditional on the session
not having been deleted/archived in the meantime; two related hardening
fixes close the same class of gap in continueSession's revival path and the
stuck-session reaper sweep.

**Migration**: `20260706034600000_account_session_limit_override.sql`
- Adds nullable `kortix.credit_accounts.max_concurrent_sessions` (int)
- Idempotent upsert seeding the internal Kortix dogfood account
  (`3b1fc472-a90e-404f-823f-ca42f6b32e4d`) with an effectively-uncapped
  override of 100000
This is the only migration pending between prod and staging.

**Rollback**: additive-only migration (ADD COLUMN IF NOT EXISTS + idempotent
upsert), safe to leave in place. A bad release rolls back via Path 1 in
docs/runbooks/rollback-procedure.md: revert the merge commit on `prod`
(PR, reviewed, same gate as forward deploys) — Argo CD self-heals to the
prior image tag. No down-migration is needed or defined (matches this
repo's node-pg-migrate convention).
