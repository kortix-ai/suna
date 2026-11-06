/**
 * The public surface of `workspaces/`: the ONE import path for workspace
 * identity and lifecycle (design.md §3.2 C2). The lint rule
 * `kortix-api/workspace-store-only` refuses an import of `accounts`,
 * `projects` or `workspaces` from `@kortix/db` outside `src/workspaces/`.
 * (Not `index.ts`: a domain `index.ts` is the http layer in the API lint, and
 * services must be able to import this.)
 */
export {
  asWorkspaceAccountKey,
  asWorkspaceId,
  isUuid,
  type WorkspaceAccountKey,
  type WorkspaceId,
} from './ids';
export {
  pickWorkspace,
  resolveCanonicalWorkspace,
  resolveWorkspace,
  WORKSPACE_AMBIGUOUS_CODE,
  WorkspaceAmbiguousError,
  type ResolvedWorkspace,
  type WorkspaceResolveCandidate,
} from './resolve';
export {
  accountIsPaying,
  getWorkspace,
  listAccountWorkspaces,
  listUserWorkspaceCandidates,
  readAccountEngineFacts,
  workspaceIdOfAccount,
  workspaceRecordFromJson,
  workspaceState,
  type WorkspaceCandidate,
  type WorkspaceLifecycle,
  type WorkspaceRecord,
  type WorkspaceState,
} from './store';
export {
  closeWorkspace,
  fillWorkspaceIds,
  isWorkspaceLifecycleError,
  prepareWorkspaceSetup,
  restoreWorkspace,
  WORKSPACE_CLOSE_REASON,
  WORKSPACE_CLOSE_REASON_SUBSCRIPTION,
  WORKSPACE_DELETION_GRACE_DAYS,
  WorkspaceLifecycleError,
  type CloseWorkspaceResult,
  type WorkspaceLifecycleErrorCode,
} from './lifecycle';
export {
  cancelPersonDeletion,
  deletePerson,
  getPersonDeletionRequest,
  PERSON_DELETION_GRACE_DAYS,
  planPersonDeletion,
  processScheduledPersonDeletions,
  SOLE_OWNER_OF_SHARED_WORKSPACE_CODE,
  SoleOwnerOfSharedWorkspaceError,
  type PersonDeletionBlocker,
  type PersonDeletionPlan,
} from './person-deletion';
export { reportShadow, SHADOW_ROW_FIELD, shadowMismatchFields } from './shadow';
export {
  isWorkspaceOnePerAccountConflict,
  WORKSPACE_HAS_PROJECT_CODE,
  WORKSPACE_HAS_PROJECT_MESSAGE,
  WORKSPACE_ONE_PER_ACCOUNT_INDEX,
  workspaceHasProjectBody,
  workspaceHasProjectDenial,
  WorkspaceHasProjectError,
  type WorkspaceHasProjectBody,
} from './one-project';
// The workspace split (runner, ledger, invariants) is NOT re-exported here:
// it imports projects/surface, and projects/ imports this file. Import it from
// `workspaces/split/split-runner` and `workspaces/split/invariants`. lifecycle.ts
// and person-deletion.ts reach projects/, billing/ and accounts/ only through
// dynamic imports for the same reason.
