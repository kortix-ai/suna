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
  ACCOUNT_ACTIONS,
  PROJECT_ACTIONS,
  resourceTypeForAction,
  type ResourceType,
} from './actions';
