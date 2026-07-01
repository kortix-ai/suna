import type { Effect } from 'effect';
// Public IAM surface for the rest of the codebase.
//
// authorize / assertAuthorized / listAccessibleResources all go through
// the V2 engine (the V1 policy engine and the dispatcher's flag-routing
// were retired in PR5).
export {
  authorize,
  assertAuthorized,
  listAccessibleResources,
  filterAccessibleProjectResources,
} from './dispatcher';
export {
  RESOURCE_GRANT_TYPES,
  isResourceType,
  listResourceGrants,
  upsertResourceGrant,
  deleteResourceGrant,
  hasAnyResourceGrants,
  unscopedResourceIds,
  type ResourceType as ResourceGrantType,
  type PrincipalType as ResourceGrantPrincipalType,
} from './resource-grants';
export {
  ACCOUNT_ACTIONS,
  PROJECT_ACTIONS,
  ACTION_CATALOG,
  VALID_ACTIONS,
  resourceTypeForAction,
  type ResourceType,
} from './actions';
