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
// split across ./iam/<group> modules; each exports a registerIam<Group>Routes()
// function. registerIamRoutes() calls them in route-registration order.
// OpenAPIHono dispatches in registration order, and that order is part of the
// contract.

import { iamRouter } from './iam/app';
import { registerIamGroupsRoutes } from './iam/groups'; // groups, group members, group→project grants
import { registerIamMembersRoutes } from './iam/members'; // super-admin, member groups / project-access / effective(+batch)
import { registerIamResourceGrantsRoutes } from './iam/resource-grants'; // account-wide resource-grants rollup (agent/skill grants across every project)
import { registerIamMfaRoutes } from './iam/mfa'; // account-wide MFA enforcement
import { registerIamScimTokensRoutes } from './iam/scim-tokens'; // SCIM provisioning tokens
import { registerIamSsoRoutes } from './iam/sso'; // SAML SSO provider + group mappings
import { registerIamEnterpriseDemoRoutes } from './iam/enterprise-demo'; // self-serve enterprise-preview toggle
import { registerIamPoliciesRoutes } from './iam/policies'; // session policy, active sessions / revoke, PAT policy
import { registerIamServiceAccountsRoutes } from './iam/service-accounts'; // service accounts (non-human IAM principals)
import { registerIamOauthClientsRoutes } from './iam/oauth-clients'; // Sign in with Kortix: OAuth client registry
import { registerIamSessionOversightRoutes } from './iam/session-oversight'; // owner/admin access to every session (owner-only toggle)
import { registerIamCustomRolesRoutes } from './iam/custom-roles'; // IAM v1: custom roles + action sets + principal→role policies
import { registerIamAssignmentsRoutes } from './iam/assignments'; // canonical: role_assignments CRUD + the permission catalog

/**
 * Registers every IAM route on `iamRouter`. accounts/index.ts calls it once,
 * right before it mounts the router. Never call it at import time (see
 * registerAllProjectRoutes in ../projects).
 */
export function registerIamRoutes(): void {
  // custom-roles registers first. Before routes were registered explicitly, a
  // project route imported ./iam/custom-roles, so its import side effect ran
  // before this barrel's imports. The measured order is kept as is.
  registerIamCustomRolesRoutes();
  registerIamGroupsRoutes();
  registerIamMembersRoutes();
  registerIamResourceGrantsRoutes();
  registerIamMfaRoutes();
  registerIamScimTokensRoutes();
  registerIamSsoRoutes();
  registerIamEnterpriseDemoRoutes();
  registerIamPoliciesRoutes();
  registerIamServiceAccountsRoutes();
  registerIamOauthClientsRoutes();
  registerIamSessionOversightRoutes();
  registerIamAssignmentsRoutes();
}

export { iamRouter };
