---
recorded: 2026-10-22T13:34:54Z
incident_date: 2026-10-22
---
# Unblock a directory invite through membership or SSO, never by editing the invite row

**Rule:** A SCIM invite row belongs to the IdP. A manual edit to it (`invited_by`, `expires_at`) lasts only until the IdP re-provisions the user: a deactivate/reactivate or delete/create deletes the row and inserts a new one with `invited_by = NULL`. To unblock a person, use a path whose result outlives SCIM: they sign in through the account's own IdP (the invite page's **Continue with single sign-on**), or they accept once a person has resent the invite. After that the membership row exists, and SCIM binds to it.

**Trigger surface:** Support for a self-host with `ENABLE_EMAIL_AUTOCONFIRM=true` (no email provider) where a person sees "Switch accounts" or `403 email_unconfirmed` for their own address on a SCIM invite.

**Incident:** 2026-10-22, a prod self-host. A directory guest (address outside the IdP's domain) signed up with a password. `invited_by` was NULL (SCIM), so the invite matched no login, and `/auth` could not route the guest's domain to the IdP. A manual `UPDATE … SET invited_by` unblocked the row. The IdP re-provisioned the user minutes later and recreated the row with `invited_by = NULL`, so the person stayed blocked. A watcher re-applied the vouch until the person accepted. Fixed in #10707: provider-id SSO from the invite page, own-IdP trust on invite routes, and Resend vouches.

**Enforcement:** `apps/api/src/__tests__/integration-email-autoconfirm-trust.test.ts` (own-IdP guest on an outside domain accepts; resend vouches). Nothing stops a manual row edit: this entry is the guard.
