# Enterprise Auth Readiness

Status: investigation note, 2026-05-22

## Decision

Do not replace Supabase Auth with Better Auth as part of the enterprise-readiness push.

Kortix should keep the current architecture for the next release:

- Supabase Auth owns user identity, hosted auth, OAuth, email/password, JWTs, MFA primitives, and managed SAML SSO where needed.
- Kortix owns accounts, projects, membership, product IAM, runtime policy, API tokens, billing mapping, audit events, and enterprise admin UX.
- Better Auth remains a later spike only if it proves materially better SAML/OIDC/SCIM self-service without breaking existing user IDs, mobile auth, CLI/PAT auth, or Supabase-backed runtime assumptions.

The reason is simple: the hard enterprise work is not "swap auth libraries". It is domain verification, IdP routing, SCIM provisioning, deprovisioning, group mapping, policy enforcement, audit export, and making IAM the only runtime authority. A Better Auth migration would add risk before those product controls are complete.

## Current Kortix State

Strong pieces already present:

- Account membership and pending invites in `kortix.account_members` and `kortix.account_invitations`.
- IAM groups, roles, permissions, allow/deny policies, super-admin, and token principals.
- System roles for account admin, read-only admin, auditor, project admin/editor/viewer/deployer, trigger, and channel access.
- Audit event table and middleware for successful state-changing `/v1/*` requests, plus detailed IAM mutation audit records.
- CLI/account tokens with scoped token-as-principal semantics.
- MFA client support via Supabase MFA/AAL checks.
- Security and E2E coverage around auth middleware, JWT validation, CORS, API keys, rate limits, audit logging, and account/project access.

Main robustness gaps:

- IAM is not yet the single authority. Some project list/access paths still use legacy `account_role` and `project_members` shortcuts, even though writes sync into IAM.
- SSO/SCIM are not implemented in Kortix product state. There is a `source='scim'` group enum, but no SCIM server, SAML connection table, verified domain table, IdP routing, or group mapping surface.
- Enterprise sign-in policy is missing: no account-level "require SSO", "disable password login", "require MFA", "allowed domains", or "JIT provisioning policy".
- Directory deprovisioning semantics are undefined: suspend user, remove account membership, revoke PATs, stop sessions, rotate secrets, preserve audit history.
- Audit logs need enterprise hardening: export API, SIEM/webhook sink, retention policy, actor IP/user-agent normalization, immutable append-only guarantees, and coverage for auth/SSO/SCIM events.
- The unified IAM/vault plan is still draft. Secrets/OAuth/session scoping are not yet first-class IAM resources.

## Better Auth vs Supabase

Better Auth advantages:

- Library-level control in the app, with plugins for organizations, admin, SSO, SCIM, API keys, two-factor, and passkeys.
- Better fit if Kortix wants self-hosted auth tables fully owned inside the app database.
- SCIM plugin is a real draw if the goal is app-owned directory sync endpoints instead of stitching SCIM manually.

Better Auth risks:

- It is a full identity/session migration, not an enterprise feature toggle.
- Existing web, mobile, API middleware, Supabase JWT verification, local auth flows, OAuth callback handling, and test helpers are Supabase-shaped.
- Supabase user ID continuity must be preserved or every product table with `user_id` becomes migration-sensitive.
- Better Auth audit/org logs would still not replace Kortix product audit events.

Supabase advantages:

- Already wired through the product: frontend, mobile, middleware, JWT verification, callbacks, test helpers, and account resolution.
- Managed Auth gives SAML SSO, MFA, OAuth providers, admin user APIs, and stable JWT infrastructure without an app-auth rewrite.
- Lowest risk path to ship enterprise readiness on the existing product model.

Supabase gaps Kortix must build around:

- Supabase does not give Kortix product IAM, project access, runtime approval, token scoping, billing authority, or product audit semantics.
- Supabase SAML SSO still needs Kortix-side account mapping, verified domains, JIT/member provisioning, IdP enforcement, and audit events.
- Directory sync should be a Kortix-controlled SCIM surface unless Supabase adds a product-fit managed option that can write exactly into `account_members`, `account_groups`, and `account_group_members`.

## Enterprise Checklist

Minimum credible enterprise auth/IAM scope:

- SAML SSO per account with verified domains and IdP metadata lifecycle.
- Optional OIDC enterprise connection support if buyer IdPs require it.
- Domain discovery and IdP-first login routing by email domain.
- Account policies: require SSO, require MFA, disable password login, restrict invites to verified domains, allow JIT provisioning, session lifetime, idle timeout.
- SCIM 2.0 provisioning for Users and Groups.
- SCIM deprovisioning: suspend account membership, revoke PATs, remove policies/groups, stop or restrict active sessions, preserve audit trail.
- Group mapping from IdP groups to Kortix IAM groups and policies.
- IAM becomes the only runtime authority. Legacy bridges can exist during migration, but routes should call `authorize` or `assertAuthorized`.
- Product resources in IAM: project, session, sandbox, trigger, channel, token, vault/secret/OAuth credential, deployment.
- Access review UX: who has access to this account/project/session/secret and why.
- Break-glass super-admin with explicit audit events and limited assignment path.
- Audit log export API, CSV/JSON export, SIEM/webhook sink, retention settings, and coverage for auth, SSO, SCIM, IAM, token, billing, project, vault, session, runtime, and approval events.
- Admin APIs for accounts, members, groups, roles, policies, audit logs, tokens, and SSO configuration.
- Security controls: rate limits, bot protection for auth endpoints, password policy where passwords are allowed, MFA enforcement, passkeys optional, session revocation, token rotation, and suspicious activity audit.
- Enterprise ops: DPA, SOC 2 evidence, subprocessors, data retention/deletion, backups, incident response, SLA/support, status page, and self-host/VPC/air-gap deployment posture.

## Implementation Plan

Phase 0: finish IAM consolidation.

- Replace remaining `isAccountManager`, raw `accountRole`, and direct `project_members` authorization decisions with `assertAuthorized`.
- Keep legacy bridges on until behavior is proven equivalent.
- Add route-level regression tests for project list, project access changes, account member changes, token scopes, and deny-wins behavior.

Phase 1: ship enterprise SSO on existing Supabase Auth.

- Add `account_sso_connections`, `account_verified_domains`, and `account_auth_policies`.
- Implement login domain discovery and account-level SSO enforcement.
- Use Supabase SAML SSO as the authentication provider, then bind the authenticated Supabase user to `account_members`.
- Audit every SSO connection change and SSO login/provisioning event.

Phase 2: build Kortix SCIM.

- Add SCIM bearer tokens per account with scoped audit and rotation.
- Implement SCIM Users and Groups endpoints.
- Map SCIM users to `account_members`, groups to `account_groups`, and group membership to `account_group_members`.
- Define deprovisioning as suspend/remove membership plus PAT revocation and policy cleanup.

Phase 3: harden enterprise audit and access review.

- Add audit export and SIEM sink.
- Add access-explanation endpoints for member/project/session/secret access.
- Add retention settings and immutable append-only safeguards.

Phase 4: optional Better Auth spike.

- Prototype Better Auth in a separate branch only after Phases 0-2 are clear.
- Required proof: preserve Supabase user IDs or provide a zero-loss remap, keep mobile/web/CLI auth green, preserve PAT semantics, support SAML and SCIM with account-scoped admin UX, and avoid duplicating Kortix IAM/product audit state.

## Recommendation

For this product and timing, Supabase Auth plus Kortix-owned IAM/SCIM/SSO admin state is the right path. Better Auth is worth tracking and maybe spiking later, but migrating now would mostly move identity plumbing while the actual enterprise requirements would still remain to be built in Kortix.
