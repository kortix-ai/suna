// IAM V2 REST surface — groups, super-admin promotion, effective-permission
// probes, account-wide gates (MFA, sessions, PAT policy), custom roles, and
// integrations (SCIM, SAML SSO, service accounts).
//
// Older V1 surfaces (permission boundary, strict mode, approvals,
// break-glass, external grants, drift, analytics, simulator, policy
// templates) were removed in PR5c when the V2 engine became the only
// authorization path; their backend modules were removed in PR5d, and the
// iam_break_glass_grants / iam_approval_requests tables are dead (dropping
// them is a final destructive step gated on operator sign-off).
//
// Custom roles + policies were REBUILT from scratch in Phase 3 of
// feat/iam-rbac-v1 (June 2026, ./iam/custom-roles.ts): DB-backed custom
// roles (iam_roles / iam_role_actions) and role bindings (iam_policies) are
// live, available on every tier (the 'rbac' entitlement is granted to all
// plans since 2026-07-08), and read by the V2 engine
// (../iam/engine-v2.ts), which unions their granted actions additively on
// top of the fixed built-in preset roles. These tables are NOT dead.
//
// Every handler asserts the relevant IAM action via assertAuthorized()
// from the engine entry-point in ../iam.
//
// ─── Structure ──────────────────────────────────────────────────────────────
// This file is a thin BARREL. The router instance + shared OpenAPI schemas
// live in ./iam/app, shared helpers in ./iam/helpers, and the ~36 routes are
// split across ./iam/<group> modules; each exports a register function that
// adds its routes to the shared `iamRouter`. OpenAPIHono dispatches in
// registration order, so the order of the calls below is part of the
// contract. custom-roles registers first: before the calls were explicit, a
// project route imported it, and its import side effect ran before every
// other IAM module.

import { registerIamGroupsRoutes } from './iam/groups';
import { registerIamMembersRoutes } from './iam/members';
import { registerIamResourceGrantsRoutes } from './iam/resource-grants';
import { registerIamMfaRoutes } from './iam/mfa';
import { registerIamScimTokensRoutes } from './iam/scim-tokens';
import { registerIamSsoRoutes } from './iam/sso';
import { registerIamEnterpriseDemoRoutes } from './iam/enterprise-demo';
import { registerIamPoliciesRoutes } from './iam/policies';
import { registerIamServiceAccountsRoutes } from './iam/service-accounts';
import { registerIamOauthClientsRoutes } from './iam/oauth-clients';
import { registerIamSessionOversightRoutes } from './iam/session-oversight';
import { registerIamCustomRolesRoutes } from './iam/custom-roles';
import { registerIamAssignmentsRoutes } from './iam/assignments';
import { iamRouter } from './iam/app';

registerIamCustomRolesRoutes(); // IAM v1: custom roles + action sets + principal→role policies
registerIamGroupsRoutes(); // groups, group members, group→project grants
registerIamMembersRoutes(); // super-admin, member groups / project-access / effective(+batch)
registerIamResourceGrantsRoutes(); // account-wide resource-grants rollup (agent/skill grants across every project)
registerIamMfaRoutes(); // account-wide MFA enforcement
registerIamScimTokensRoutes(); // SCIM provisioning tokens
registerIamSsoRoutes(); // SAML SSO provider + group mappings
registerIamEnterpriseDemoRoutes(); // self-serve enterprise-preview toggle
registerIamPoliciesRoutes(); // session policy, active sessions / revoke, PAT policy
registerIamServiceAccountsRoutes(); // service accounts (non-human IAM principals)
registerIamOauthClientsRoutes(); // Sign in with Kortix: OAuth client registry
registerIamSessionOversightRoutes(); // owner/admin access to every session (owner-only toggle)
registerIamAssignmentsRoutes(); // canonical: role_assignments CRUD + the permission catalog

export { iamRouter };
