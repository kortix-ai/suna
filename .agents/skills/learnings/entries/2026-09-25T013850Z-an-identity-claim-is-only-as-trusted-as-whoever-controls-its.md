---
recorded: 2026-09-25T01:38:50Z
incident_date: 2026-09-24
commit: 0f4242ed0e
---
# An identity claim is only as trusted as whoever controls its source

**Rule:** Before an email, id or scope from a request decides whose identity or
which tenant a write touches, name who controls that value. An email a SAML IdP
asserts is controlled by the account admin who configured the IdP, so it proves
nothing outside that account until the account verified the domain
(`iam/email-trust.ts`). A `scope_id` in a body is controlled by the caller, so a
write authorized against the URL account must prove the scope belongs to it.
**Near-miss:** a codebase audit found invite matching, add-by-email and SAML
identity merge keyed on IdP-asserted emails, `enforce_sso` honoured on unverified
domains, and project-scoped assignments accepted for another account's project.
Fixed before any known use, PR #7615.
**Enforcers:** flows `SSO-1`, `SSO-2`, `SSO-3`, `IAM-41`, `IAM-42`;
`integration-iam-sso-sync.test.ts`; trigger
`role_assignments_project_account_guard`.
