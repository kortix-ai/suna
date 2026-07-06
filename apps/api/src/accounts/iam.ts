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
// live, Enterprise-entitlement-gated ('rbac'), and read by the V2 engine
// (../iam/engine-v2.ts), which unions their granted actions additively on
// top of the fixed built-in preset roles. These tables are NOT dead.
//
// Every handler asserts the relevant IAM action via assertAuthorized()
// from the engine entry-point in ../iam.
//
// ─── Structure ──────────────────────────────────────────────────────────────
// This file is a thin BARREL. The router instance + shared OpenAPI schemas
// live in ./iam/app, shared helpers in ./iam/helpers, and the ~36 routes are
// split across ./iam/<group> modules that register themselves on the shared
// `iamRouter` via import side effect. The imports below run IN THE ORIGINAL
// ROUTE-REGISTRATION ORDER — do not reorder them: OpenAPIHono registers
// routes in import/execution order and that order is part of the contract.

import './iam/groups'; // groups, group members, group→project grants
import './iam/members'; // super-admin, member groups / project-access / effective(+batch)
import './iam/mfa'; // account-wide MFA enforcement
import './iam/scim-tokens'; // SCIM provisioning tokens
import './iam/sso'; // SAML SSO provider + group mappings
import './iam/enterprise-demo'; // self-serve enterprise-preview toggle
import './iam/policies'; // session policy, active sessions / revoke, PAT policy
import './iam/service-accounts'; // service accounts (non-human IAM principals)
import './iam/custom-roles'; // IAM v1: custom roles + action sets + principal→role policies

export { iamRouter } from './iam/app';
