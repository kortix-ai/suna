// Public IAM surface for the rest of the codebase.
//
// authorize / assertAuthorized / listAccessibleResources all go through
// the V2 engine.
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
