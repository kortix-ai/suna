// Public IAM surface for the rest of the codebase.
//
// authorize / assertAuthorized / listAccessibleResources all go through
// the V2 engine (the V1 policy engine and the dispatcher's flag-routing
// were retired in PR5).
export {
  authorize,
  assertAuthorized,
  listAccessibleResources,
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
