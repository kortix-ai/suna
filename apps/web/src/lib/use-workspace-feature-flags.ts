'use client';

import type { FeatureFlagKey } from '@kortix/sdk';
import { useFeatureFlag } from '@kortix/sdk/react';

/**
 * Every feature flag for one workspace, in one object.
 *
 * This is NOT a second gating primitive — every member below is `useFeatureFlag`
 * from `@kortix/sdk/react`, the one primitive. It exists for the two call sites
 * that must decide about an ARBITRARY flag chosen at runtime (the menu
 * registry's `requiresFlag`, read by the command palette and the right sidebar)
 * and so cannot name one key at author time.
 *
 * The calls are enumerated, never looped, so the hook count is fixed. They all
 * read the same `qk.workspace.detail(workspaceId)` cache entry, so this costs one
 * fetch, not ten. `flag-map-coverage.test.ts` pins the map against the SDK's
 * `FEATURE_FLAG_KEYS`, so a new flag cannot be silently un-gated.
 *
 * Fail-closed: every member is `false` until the workspace detail resolves.
 */
export function useWorkspaceFeatureFlags(workspaceId: string | null | undefined): {
  flags: Record<FeatureFlagKey, boolean>;
  isLoading: boolean;
} {
  const agentTunnel = useFeatureFlag(workspaceId, 'agent_tunnel');
  const marketplace = useFeatureFlag(workspaceId, 'marketplace');
  const connectorsApiDiscover = useFeatureFlag(workspaceId, 'connectors_api_discover');
  const agentmailEmail = useFeatureFlag(workspaceId, 'agentmail_email');
  const teams = useFeatureFlag(workspaceId, 'teams');
  const voice = useFeatureFlag(workspaceId, 'voice');
  const llmGateway = useFeatureFlag(workspaceId, 'llm_gateway');
  const reviewCenter = useFeatureFlag(workspaceId, 'review_center');
  const metaAgent = useFeatureFlag(workspaceId, 'meta_agent');
  const apps = useFeatureFlag(workspaceId, 'apps');

  return {
    flags: {
      agent_tunnel: agentTunnel.enabled,
      marketplace: marketplace.enabled,
      connectors_api_discover: connectorsApiDiscover.enabled,
      agentmail_email: agentmailEmail.enabled,
      teams: teams.enabled,
      voice: voice.enabled,
      llm_gateway: llmGateway.enabled,
      review_center: reviewCenter.enabled,
      meta_agent: metaAgent.enabled,
      apps: apps.enabled,
    },
    isLoading: apps.isLoading,
  };
}
