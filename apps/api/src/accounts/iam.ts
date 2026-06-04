// IAM V2 REST surface — groups, super-admin promotion, effective-permission
// probes, account-wide gates (MFA, sessions, PAT policy), and integrations
// (SCIM, SAML SSO, service accounts).
//
// V1 surfaces (policies, custom roles, permission boundary, strict mode,
// approvals, break-glass, external grants, project groups, drift,
// analytics, simulator, policy templates) were removed in PR5c when the
// V2 engine became the only authorization path. The V1 backend modules
// they relied on were removed in PR5d. The underlying iam_policies /
// iam_roles / iam_role_permissions / iam_break_glass_grants /
// iam_approval_requests / project_groups DB tables still exist but are
// no longer read from or written to — dropping them is a final
// destructive step gated on operator sign-off.
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
import './iam/policies'; // session policy, active sessions / revoke, PAT policy
import './iam/service-accounts'; // service accounts (non-human IAM principals)

export { iamRouter } from './iam/app';
