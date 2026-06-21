-- ╔════════════════════════════════════════════════════════════════════╗
-- ║  Drop IAM V1 — tables, enums, columns                              ║
-- ║                                                                    ║
-- ║  The V1 policy-based IAM engine was retired in PR5 (commits        ║
-- ║  1b43422cb / acb49b0c6 / 2f0662373). Every reader and writer of    ║
-- ║  these tables is gone; the V2 engine reads account_members.        ║
-- ║  account_role + project_members.project_role + project_group_grants║
-- ║  + account_group_members. This migration removes the now-dead      ║
-- ║  schema so nothing can accidentally write to it again.             ║
-- ║                                                                    ║
-- ║  Order matters: tables first (CASCADE handles internal FKs),       ║
-- ║  then enum types they referenced, then V1-only columns on the      ║
-- ║  surviving accounts + account_members tables.                      ║
-- ╚════════════════════════════════════════════════════════════════════╝

-- ── Tables ───────────────────────────────────────────────────────────
-- CASCADE so the dependent iam_role_permissions / iam_policies rows
-- (FK → iam_roles) and project_group_members (FK → project_groups)
-- come along automatically.
DROP TABLE IF EXISTS kortix.iam_action_usage CASCADE;
DROP TABLE IF EXISTS kortix.iam_approval_requests CASCADE;
DROP TABLE IF EXISTS kortix.iam_break_glass_grants CASCADE;
DROP TABLE IF EXISTS kortix.iam_policies CASCADE;
DROP TABLE IF EXISTS kortix.iam_role_permissions CASCADE;
DROP TABLE IF EXISTS kortix.iam_roles CASCADE;
DROP TABLE IF EXISTS kortix.project_group_members CASCADE;
DROP TABLE IF EXISTS kortix.project_groups CASCADE;

-- ── Enum types ──────────────────────────────────────────────────────
-- iam_resource_type is shared with project_group_grants.role? No —
-- V2 uses project_role enum (manager/editor/viewer). These enums were
-- exclusive to V1 tables and have no other references now that the
-- tables are gone.
DROP TYPE IF EXISTS kortix.iam_policy_effect;
DROP TYPE IF EXISTS kortix.iam_principal_type;
DROP TYPE IF EXISTS kortix.iam_resource_type;
DROP TYPE IF EXISTS kortix.iam_scope_type;

-- ── Accounts columns ───────────────────────────────────────────────
-- iam_v2_enabled was the rollout flag; every account is on V2 now.
-- iam_strict_mode was the V1 toggle disabling legacy bridges; V2
-- has no bridges to toggle.
-- iam_approvals_required gated which V1 actions required two-person
-- sign-off; the approvals workflow was deleted in PR5c.
ALTER TABLE kortix.accounts DROP COLUMN IF EXISTS iam_v2_enabled;
ALTER TABLE kortix.accounts DROP COLUMN IF EXISTS iam_strict_mode;
ALTER TABLE kortix.accounts DROP COLUMN IF EXISTS iam_approvals_required;

-- ── account_members columns ────────────────────────────────────────
-- permission_boundary was the V1 max-envelope of action prefixes;
-- there's no boundary concept in V2.
-- The external_* fields were the V1 cross-account-sharing surface
-- (a member from account A getting limited grants on account B).
-- V2 doesn't model that — external collaborators are just regular
-- account_members with their own account_role on the account they're
-- collaborating in.
-- scim_external_id stays — SCIM provisioning is still live in V2.
ALTER TABLE kortix.account_members DROP COLUMN IF EXISTS permission_boundary;
ALTER TABLE kortix.account_members DROP COLUMN IF EXISTS is_external;
ALTER TABLE kortix.account_members DROP COLUMN IF EXISTS external_grant_expires_at;
ALTER TABLE kortix.account_members DROP COLUMN IF EXISTS external_granted_by;
ALTER TABLE kortix.account_members DROP COLUMN IF EXISTS external_note;
