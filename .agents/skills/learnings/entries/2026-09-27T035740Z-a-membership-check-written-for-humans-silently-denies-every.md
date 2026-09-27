---
recorded: 2026-09-27T03:57:40Z
incident_date: 2026-09-27
---
# A membership check written for humans silently denies every non-human principal, forever

**Rule:** when a system gains a new class of principal (service accounts /
agents), audit every existing "is this caller allowed on this account?"
check that queries ONE membership table — it will deny the new principal
type forever, not error loudly, because "not found" and "not allowed" look
identical from inside that query.

**Trigger surface:** adding or reviewing any account-membership/authorization
check when the codebase has more than one principal table (e.g.
`account_members` and `service_accounts`), especially on an attribution field
(`created_by`, `actor_id`) that can hold either kind of id.

**Incident:** `isAccountMember` (`apps/api/src/shared/preview-ownership.ts`)
only checked `account_members`. A trigger/automation session is attributed
to the agent's `service_accounts` row, never an `account_members` row, so
`resolvePreviewUserContext` returned null for every one of those sessions and
the signed proxy header was never attached — a permanent 401 on the daemon's
transcript-save call. 76h window: 23,380 capture failures, 72% of sessions
with no saved transcript.

**Enforcement:** `isAccountServiceAccount` added as a second, equally-
authoritative check (`preview-ownership.ts`); `preview-ownership.test.ts`.
**Found, not fixed (separate, pre-existing):** `resolveAccountId` bootstraps
a phantom personal account for any unrecognized `userId`, including a
service-account id — runs on this same path today, unrelated to this fix.
