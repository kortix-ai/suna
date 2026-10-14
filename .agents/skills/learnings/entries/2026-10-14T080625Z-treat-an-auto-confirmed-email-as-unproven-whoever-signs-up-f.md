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
operator allowlist (`shared/platform-roles.ts`).

**Trigger surface:** adding a caller of `emailTrustedSql` or
`trustedEmailForUser`, a new email-keyed lookup on `auth.users`, or a new
self-host auth default in `apps/cli/src/self-host/shared-runtime-defaults.ts`.

**Incident:** near-miss, KRTX-1715, found by the 2026-10-06 product audit. On a
default self-host (open sign-up, autoconfirm on, SAML on), a stranger could
register an IdP on a personal account and become platform admin through the
allowlist (path B, closed by PR #9331), or sign up first as a colleague's
address and receive that colleague's invites and SCIM groups (path C, closed
for auto-claim, SCIM and add-by-email by the change that added this entry).
No known use.

**Enforcement:** `apps/api/src/__tests__/integration-email-autoconfirm-trust.test.ts`
(fact on and off, SCIM `POST /Users` over HTTP),
`integration-platform-admin-identity.test.ts`, flows `ADM-25` and `SSO-5`, and
the `open-sign-up` doctor check and `init` warning in
`apps/cli/src/self-host/__tests__/self-host-cli.test.ts`. Still open: explicit
invite list/accept under autoconfirm, and binding platform admin to a user id
(KRTX-1715 decisions a and b).
