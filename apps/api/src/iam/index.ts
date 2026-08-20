// Public IAM surface for the rest of the codebase.
//
// ONE store (`kortix.role_assignments`), ONE engine (`./authorize`) and ONE
// write path (`./assignments`), all taking the structured `Actor` built once in
// `middleware/auth.ts`. The V1 policy engine, the flag-routing dispatcher and
// `engine-v2` are gone — a positional `(userId, accountId, action, target?,
// actingTokenId?, requestCtx?)` signature cannot be expressed any more, which is
// what made the agent-grant fold silently skippable.
export {
  authorize,
  assertAuthorized,
  listAccessible,
  filterAccessibleObjects,
  type Obj,
  type Verdict,
  type Accessible,
  type Reason,
} from './authorize';
export {
  buildActor,
  actorFor,
  actorOf,
  actorForUser,
  actorForToken,
  actorForServiceAccount,
  pendingPrincipalId,
  type Actor,
  type Credential,
  type PrincipalRef,
} from './actor';
export {
  assignRole,
  revokeAssignment,
  listAssignments,
  assignmentsForProject,
  assignmentsForPrincipals,
  assignmentsForRoles,
  findExpiredAssignments,
  auditAssignmentExpired,
  groupPrincipalIds,
  SYSTEM_ACTOR,
  type AssignRoleInput,
  type AssignmentRow,
  type AssignmentFilter,
  type AssignmentSource,
  type Writer,
} from './assignments';
export {
  loadPermissionCatalog,
  loadSystemRoles,
  loadAccountRoles,
  scopeForAction,
  unscopedDefaultFor,
  type ObjectType,
  type ScopeType,
  type PermissionEntry,
} from './catalog';
export {
  RESOURCE_GRANT_TYPES,
  isResourceType,
  CREATABLE_RESOURCE_GRANT_TYPES,
  isCreatableResourceType,
  listResourceGrants,
  upsertResourceGrant,
  deleteResourceGrant,
  hasAnyResourceGrants,
  unscopedResourceIds,
  type ResourceType as ResourceGrantType,
  type PrincipalType as ResourceGrantPrincipalType,
} from './resource-grants';
export {
  normalizeProjectRole,
  parseAssignableProjectRole,
  maxProjectRole,
  isAccountManager,
  PROJECT_ROLE_RANK,
  PROJECT_ROLE_INPUT_ERROR,
  type AccountRole,
  type ProjectRole,
} from './roles';
export {
  ACCOUNT_ACTIONS,
  PROJECT_ACTIONS,
  ACTION_CATALOG,
  VALID_ACTIONS,
  resourceTypeForAction,
  type ResourceType,
} from './actions';
