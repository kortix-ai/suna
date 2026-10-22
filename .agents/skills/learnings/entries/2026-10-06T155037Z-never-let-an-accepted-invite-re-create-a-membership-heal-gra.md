---
recorded: 2026-10-06T15:50:37Z
incident_date: 2026-10-06
---
# Never let an accepted invite re-create a membership; heal grants only for a current member.

**Rule:** `POST /account-invites/:id/accept` on an already-accepted invite refuses (410) unless the caller is a CURRENT member, and never rewrites the member's role. Member removal and leave do not delete the invite, so any redeem path must treat the invite as spent once membership is gone.

**Trigger surface:** Writing or reviewing an invite, join-link, or access-request redeem path; any code that inserts `account_memberships` with the system actor.

**Incident:** 2026-10-06 repo audit. A removed or departed member re-posted the old invite id and regained membership with the original role and project grants, past the removal tombstone and the expiry check.

**Enforcement:** REST flow MEM-7 (invite, accept, remove, re-accept returns 410, caller is not a member).
