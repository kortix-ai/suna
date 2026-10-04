import { describe, expect, test } from 'bun:test';

// Characterization test (KRTX-300): pins the full public surface of the
// `sandbox-env-sync` entry module. Every name below was exported by the
// original single-file implementation; the split into sibling modules must
// keep every one of them resolving through this same import path.
import {
  ENV_SYNC_BACKGROUND_REFRESH_STALE_MS,
  type ProjectSecretPropagationResult,
  type ProjectSecretPropagationTarget,
  type SandboxEnvSnapshot,
  __pendingBackgroundEnvRefreshesForTests,
  __resetBackgroundEnvRefreshForTests,
  __resetNetworkBoundaryArmCacheForTests,
  __resetPromptModelSignatureCacheForTests,
  daemonHasConfigReleases,
  llmGatewayBaseUrlForProvider,
  propagateLlmGatewayModeToActiveSandboxes,
  propagateProjectSecretsToActiveSandboxes,
  pushSessionAgentConfigToSandbox,
  pushSessionModelToSandbox,
  pushSessionScopeToSandbox,
  resolveSandboxEnvSnapshot,
  syncSandboxEnvForPrompt,
  syncSessionSecretsToSandbox,
} from './sandbox-env-sync';

describe('sandbox-env-sync export surface', () => {
  test('every historical export still resolves through the entry path', () => {
    for (const fn of [
      llmGatewayBaseUrlForProvider,
      __resetNetworkBoundaryArmCacheForTests,
      __resetPromptModelSignatureCacheForTests,
      __pendingBackgroundEnvRefreshesForTests,
      __resetBackgroundEnvRefreshForTests,
      resolveSandboxEnvSnapshot,
      syncSandboxEnvForPrompt,
      propagateProjectSecretsToActiveSandboxes,
      syncSessionSecretsToSandbox,
      propagateLlmGatewayModeToActiveSandboxes,
      daemonHasConfigReleases,
      pushSessionAgentConfigToSandbox,
      pushSessionModelToSandbox,
      pushSessionScopeToSandbox,
    ]) {
      expect(typeof fn).toBe('function');
    }
    expect(typeof ENV_SYNC_BACKGROUND_REFRESH_STALE_MS).toBe('number');
  });

  test('the exported contracts keep their shape', () => {
    const snapshot: SandboxEnvSnapshot = {
      env: { A: 'b' },
      names: ['A'],
      revision: 'rev-1',
      scope: 'inherit',
      capabilitiesJson: '{"version":1,"capabilities":[]}',
    };
    expect(snapshot.names).toEqual(['A']);
    const target: ProjectSecretPropagationTarget = {
      session_id: 'sess-1',
      sandbox_id: null,
      status: 'failed',
      scope: null,
      revision: null,
      exported: 0,
      managed: null,
      withheld: null,
      agent_env_written: false,
    };
    const result: ProjectSecretPropagationResult = {
      ok: false,
      active_sandboxes: 0,
      targeted: 0,
      synced: 0,
      failed: 1,
      exported: 0,
      results: [target],
    };
    expect(result.results[0]?.session_id).toBe('sess-1');
  });
});
