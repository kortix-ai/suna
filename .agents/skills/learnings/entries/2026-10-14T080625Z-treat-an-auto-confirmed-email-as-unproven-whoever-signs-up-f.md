---
recorded: 2026-10-14T08:06:25Z
incident_date: 2026-10-06
---
# Treat an auto-confirmed email as unproven: whoever signs up first holds the address

**Rule:** Before an email decides whose identity a write binds (invite claim,
SCIM link, add-by-email, an operator allowlist), name who proved the address.
While Auth auto-confirms sign-ups (`ENABLE_EMAIL_AUTOCONFIRM=true`, a
self-host with no email provider), nobody did: a password email is unproven,
and only an account that already holds the user as a member trusts it, inside
that account (`iam/email-trust.ts`). A SAML-asserted email never matches an
operator allowlist (`shared/platform-roles.ts`). A self-host value that GoTrue
reads reaches it only when `supabase-auth` is recreated, so map its key in
`KEY_SERVICE_MAP` (`apps/cli/src/self-host/secrets-registry.ts`).

**Trigger surface:** adding a caller of `emailTrustedSql` or
`trustedEmailForUser`, a new email-keyed lookup on `auth.users`, a new
invite source, or a new self-host auth default in
`apps/cli/src/self-host/shared-runtime-defaults.ts`.

**Incident:** near-miss, KRTX-1715, found by the 2026-10-06 product audit. On a
default self-host (open sign-up, autoconfirm on, SAML on), a stranger could
register an IdP on a personal account and become platform admin through the
allowlist (path B, closed by PR #9331), or sign up first as a colleague's
address and receive that colleague's invites and SCIM groups (path C). The
change that added this entry closes path C for invite auto-claim, SCIM
binding, the SCIM invite (`invited_by` null: not listed, `403`
`email_unconfirmed` on accept) and add-by-email. A review of that change found
that `env set DISABLE_SIGNUP=true`, the remedy `init` and `doctor` print,
restarted only `kortix-api`, so GoTrue kept sign-up open while `doctor`
passed. No known use.

**Enforcement:** `apps/api/src/__tests__/integration-email-autoconfirm-trust.test.ts`
(fact on and off, SCIM `POST /Users` and the `/v1/account-invites` routes over
HTTP), `integration-platform-admin-identity.test.ts`, flows `ADM-25` and
`SSO-5`, and in `apps/cli/src/self-host/__tests__/self-host-cli.test.ts` the
`open-sign-up` doctor check, the `init` warning, and the `supabase-auth`
recreate on `env set` and `update --disable-signup`.

**Still open (KRTX-1715):** under autoconfirm, the operator allowlist
(`KORTIX_PLATFORM_ADMIN_EMAILS`) still matches whoever signs up first as an
allowlisted address (path A), and an invite a person sent is still accepted by
whoever holds the address. This entry's rule says both are wrong. Binding
platform admin to a user id waits on decisions a and b on the issue.
