-- Migration: member_directory_visibility
--
-- Removes `member.read` and `group.read` from the built-in `member` account
-- role. A plain member no longer sees every member and every group of the
-- account. They see the people and groups they share access with: themselves,
-- the account's owners and admins, everyone holding a role or a grant on a
-- project they can read, and the members of their own groups
-- (apps/api/src/iam/directory-visibility.ts).
--
-- `owner` and `admin` keep both leaves. An account that wants the old behavior
-- binds a custom account role holding `member.read` and `group.read` (both are
-- delegable).
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- backfill-safe: catalog edit, not a backfill. It deletes at most 2 rows of
-- kortix.role_permissions, a small catalog table. It reads no user data.
--
-- mixed-version-safe: old API code reads the role through `authorize`. Until
-- the new code is live, a plain member gets 403 on the group list and the
-- member-detail routes, and the old web app hides those two panes. Old code
-- lists members on account membership alone, so the member list keeps working.

-- One statement on the BASE TABLE kortix.role_permissions (kortix.iam_role_actions
-- is a view). The apps/web role-capability-matrix fixture reads this shape.
DELETE FROM kortix.role_permissions rp
 USING kortix.iam_roles r
 WHERE rp.role_id = r.role_id
   AND r.account_id IS NULL
   AND r.key = 'member'
   AND r.scope_type = 'account'
   AND rp.action IN ('member.read', 'group.read');
