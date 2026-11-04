---
recorded: 2026-11-04T15:57:00Z
incident_date: 2026-11-04
---
# Never let an allowlisted admin address be claimable by self sign-up on an instance that confirms nothing

**Rule:** A privilege granted by email address (`KORTIX_PLATFORM_ADMIN_EMAILS`, an invite, a SCIM user) must never go to an account that anyone could create for that address. On a self-host without email confirmation, an address proves nothing. Admin accounts come from `kortix self-host admin add` (admin API), and the auth service's before-user-created hook (`kortix.before_user_created_hook`) refuses a sign-up for an admin address in every mode. Do not close sign-up with `DISABLE_SIGNUP=true` to fix this on an SSO instance: GoTrue then refuses the first SAML sign-in of every new person too.

**Trigger surface:** Adding a grant keyed on an email address; changing self-host auth defaults (`DISABLE_SIGNUP`, `ENABLE_EMAIL_AUTOCONFIRM`, `KORTIX_SIGNUP_MODE`); changing the GoTrue hook wiring in `apps/cli/src/self-host/compose-assets.ts`.

**Incident:** 2026-11-04, a check of an enterprise self-host on v0.14.19. It had no `EMAIL_URL`, so GoTrue confirmed every sign-up. 1 of its 2 admin addresses had no account, so anyone who reached the instance could sign up with that address and become platform admin. Fixed in #11764: the before-user-created hook, `KORTIX_SIGNUP_MODE` (`invite` by default on a public instance without email), and `admin add`. No takeover was found.

**Enforcement:** `apps/cli/src/self-host/__tests__/self-host-cli.test.ts`. The tests "a domain instance without email starts invite-only…" (hook env and `KORTIX_SIGNUP_MODE=invite` in Compose) and "admin add creates the account…" go red when the wiring or the default regresses. `doctor` `open-sign-up` fails a public instance with `KORTIX_SIGNUP_MODE=open` and no email confirmation.
