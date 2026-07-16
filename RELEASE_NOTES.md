Self-host SSO out of the box, unified sign-in, and safer defaults

### New

- **Unified sign-in** — login and registration are now one email-first flow: enter your email and Kortix routes you to sign-in, sign-up, or your company's SSO automatically (with closed-signup and enforce-SSO support).
- **SSO out of the box on self-host** — SAML is enabled by default, each instance generates its own SAML signing key at init, and SSO/SCIM setup is fully documented.
- **Identity setup wizard overhaul** — reworked Entra wizard, SAML-before-SCIM ordering guidance, a provisioning health panel, an enforce-SSO toggle with clear domain consequences, and illustrated guides for all four SSO/SCIM flows.
- **Admin-controlled account creation on self-host** — creating additional accounts is now restricted to the server admin by default (signups, teams, and SSO provisioning are unaffected), and the UI hides account creation when restricted.
- **Simpler self-host CLI** — one `env` command, an `uninstall` command, and a friendlier init: a missing sandbox key warns instead of refusing to boot.
- Enterprise license availability is now exposed on account state (API + SDK).

### Fixed

- **Managed model provider now follows billing configuration by default**, fixing managed models being unavailable on some deployments.
- Self-host updater no longer fails on Docker-in-Docker mounts; the provider menu is always visible; `configure` records the admin email.
- Non-admins no longer see a spurious Git-status error.

### Behind the scenes

- Production deploys are now hard-gated end to end: the release only publishes after the API and gateway deploys verify the live version.
- Demo requests notify the team directly with lead-domain classification, and new signups sync to the contact list that powers onboarding emails.
- Repo cleanup: self-host layout consolidated, stale roots removed, self-host docs moved under Guides.
