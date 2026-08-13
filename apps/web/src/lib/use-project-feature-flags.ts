'use client';

import type { FeatureFlagKey } from '@kortix/sdk';
import { useFeatureFlag } from '@kortix/sdk/react';

/**
 * Every feature flag for one project, in one object.
 *
 * This is NOT a second gating primitive — every member below is `useFeatureFlag`
 * from `@kortix/sdk/react`, the one primitive. It exists for the two call sites
 * that must decide about an ARBITRARY flag chosen at runtime (the menu
 * registry's `requiresFlag`, read by the command palette and the right sidebar)
 * and so cannot name one key at author time.
 *
 * The calls are enumerated, never looped, so the hook count is fixed. They all
 * read the same `qk.project.detail(projectId)` cache entry, so this costs one
 * fetch, not ten. `flag-map-coverage.test.ts` pins the map against the SDK's
 * `FEATURE_FLAG_KEYS`, so a new flag cannot be silently un-gated.
 *
 * Fail-closed: every member is `false` until the project detail resolves.
 */
export function useProjectFeatureFlags(projectId: string | null | undefined): {
  flags: Record<FeatureFlagKey, boolean>;
  isLoading: boolean;
} {
  const agentTunnel = useFeatureFlag(projectId, 'agent_tunnel');
  const marketplace = useFeatureFlag(projectId, 'marketplace');
  const connectorsApiDiscover = useFeatureFlag(projectId, 'connectors_api_discover');
  const agentmailEmail = useFeatureFlag(projectId, 'agentmail_email');
  const teams = useFeatureFlag(projectId, 'teams');
  const voice = useFeatureFlag(projectId, 'voice');
  const llmGateway = useFeatureFlag(projectId, 'llm_gateway');
  const reviewCenter = useFeatureFlag(projectId, 'review_center');
  const metaAgent = useFeatureFlag(projectId, 'meta_agent');
  const apps = useFeatureFlag(projectId, 'apps');
  const warmSessions = useFeatureFlag(projectId, 'warm_sessions');

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
      warm_sessions: warmSessions.enabled,
    },
    isLoading: apps.isLoading,
  };
}
