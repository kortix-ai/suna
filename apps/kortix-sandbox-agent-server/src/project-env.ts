/** Legacy Project compatibility adapter. */
export {
  createWorkspaceSecretEnvStore as createProjectEnvStore,
  mergeWorkspaceSecretEnv as mergeProjectEnv,
  reconcileWorkspaceSecretEnv as reconcileProjectEnv,
  type WorkspaceSecretEnvStore as ProjectEnvStore,
} from './workspace-secret-env'
