// Re-export entry for `sandbox-env-sync`. The implementation lives in the
// sibling modules below; every historical import of this path keeps
// resolving the same public surface (see sandbox-env-sync.surface.test.ts).
export {
  __resetNetworkBoundaryArmCacheForTests,
  resolveSandboxEnvSnapshot,
  type SandboxEnvSnapshot,
} from './sandbox-env-snapshot';
export {
  ENV_SYNC_BACKGROUND_REFRESH_STALE_MS,
  __resetBackgroundEnvRefreshForTests,
  __pendingBackgroundEnvRefreshesForTests,
  __resetPromptModelSignatureCacheForTests,
  llmGatewayBaseUrlForProvider,
  propagateLlmGatewayModeToActiveSandboxes,
  syncSandboxEnvForPrompt,
} from './sandbox-env-push';
export {
  propagateProjectSecretsToActiveSandboxes,
  syncSessionSecretsToSandbox,
} from './sandbox-secret-propagation';
export type {
  ProjectSecretPropagationResult,
  ProjectSecretPropagationTarget,
} from './sandbox-secret-propagation';
export {
  daemonHasConfigReleases,
  pushSessionAgentConfigToSandbox,
  pushSessionModelToSandbox,
  pushSessionScopeToSandbox,
} from './sandbox-session-push';
