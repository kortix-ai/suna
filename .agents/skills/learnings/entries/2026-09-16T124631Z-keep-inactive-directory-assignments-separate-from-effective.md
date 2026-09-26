---
recorded: 2026-09-16T12:46:31Z
commit: 4876b001a4
---
# Keep inactive directory assignments separate from effective access

**Incident (2026-09-16, PR #7298 verification):** the reactivation test exposed
loss of project access when deactivation discarded SCIM group assignments.
Entra does not need to resend an unchanged group after re-enabling a user.

**Rule:** retain directory group assignments while inactive, remove effective
IAM memberships, and restore only current directory assignments on reactivation.
DELETE clears both. Group updates while inactive must update directory state.

**Enforcement:** `SCIM-10` and `SCIM-14` verify disable/enable without another
group push, removals while inactive, users disabled before first login, and
DELETE followed by explicit recreation.

**Local verification recovery (2026-09-16):** Supabase user creation and password
grants returned 504 while Docker had 402 MB free. Removing two verified unused,
downloadable API images increased free space to 3.3 GB. The 13 SCIM flows and
BILL-9b then passed together. Preserve volumes and local-only images; Docker must
refuse removal of images acquired by another container during inspection.
