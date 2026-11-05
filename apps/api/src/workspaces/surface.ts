/**
 * The public surface of `workspaces/`: import workspace identity from here.
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
  resolveWorkspace,
  WORKSPACE_AMBIGUOUS_CODE,
  WorkspaceAmbiguousError,
  type ResolvedWorkspace,
  type WorkspaceCandidate,
} from './resolve';
export {
  getWorkspace,
  splitWorkspacePatch,
  updateWorkspace,
  type WorkspacePatch,
  type WorkspaceRecord,
} from './store';
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
// `workspaces/split/split-runner` and `workspaces/split/invariants`.
