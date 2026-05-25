// Public IAM surface for the rest of the codebase.
//
// authorize / assertAuthorized / listAccessibleResources all go through
// the V2 engine (the V1 policy engine and its dispatcher were retired
// in PR5). invalidateIamV2Flag is kept as a no-op for binary
// compatibility with the V1→V2 migration script, which is the last
// caller of it.
export {
  authorize,
  assertAuthorized,
  listAccessibleResources,
  invalidateIamV2Flag,
} from './dispatcher';
export {
  type AccessibleResources,
  type AuthorizeTarget,
  type AuthorizeResult,
  type RequestContext,
} from './engine';
export { authorizeCached, deriveRequestContext } from './cache';
export { requirePermission } from './middleware';
export {
  ACCOUNT_ACTIONS,
  PROJECT_ACTIONS,
  TRIGGER_ACTIONS,
  CHANNEL_ACTIONS,
  ALL_ACTIONS,
  ACTION_CATALOG,
  VALID_ACTIONS,
  RESOURCE_TYPES,
  resourceTypeForAction,
  type Action,
  type ActionCatalogEntry,
  type ResourceType,
} from './actions';

// V1 membership-sync + system-roles surface. These are no-ops on V2 (V2
// reads account_members / project_members directly) but the import names
// stay live so existing call sites in accounts/, invites, projects/, and
// the boot routine keep compiling without churn. See legacy-shims.ts.
export {
  syncMemberAccountPolicy,
  removeMemberPolicies,
  removeProjectPoliciesForMember,
  syncProjectMemberPolicy,
  removeProjectMemberPolicy,
  backfillMembershipPolicies,
  backfillAccountMembershipPolicies,
  seedSystemRoles,
} from './legacy-shims';
