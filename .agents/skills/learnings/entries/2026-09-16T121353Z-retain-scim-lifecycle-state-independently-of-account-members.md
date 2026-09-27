---
recorded: 2026-09-16T12:13:53Z
commit: df52444330
---
# Retain SCIM lifecycle state independently of account membership

**Incident (2026-09-16, PR #7298):** SCIM deactivation deleted account membership.
A subsequent authenticated SSO request recreated it through JIT provisioning.
The IdP also lost the cached SCIM ID after an invited user first signed in.

**Rule:** persist directory identity, active state, and deletion state separately.
Serialize SCIM writes and SSO synchronization per account in database transactions.
Use the stable SCIM ID for user and group read-back before and after first login.

**Enforcement:** real HTTP flows `SCIM-9` and `SCIM-10` verify concurrent SSO
requests cannot undo deactivation, explicit reactivation works, deletion is
idempotent, and cached user IDs continue to support group membership updates.
