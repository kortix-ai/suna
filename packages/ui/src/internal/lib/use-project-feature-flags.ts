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
 * fetch, not ten. `menu-registry.flags.test.ts` pins the map against the SDK's
 * `FEATURE_FLAG_KEYS`, so a new flag cannot be silently un-gated.
 *
 * The map is `Partial` because `FeatureFlagKey` still carries deprecated
 * graduated keys that the API no longer serves; they have no member here, and
 * `requiresFlag` may only name a served key (pinned by the same test).
 *
 * Fail-closed: every member is `false` until the project detail resolves.
 */
export function useProjectFeatureFlags(projectId: string | null | undefined): {
  flags: Partial<Record<FeatureFlagKey, boolean>>;
  isLoading: boolean;
} {
  const marketplace = useFeatureFlag(projectId, 'marketplace');
  const connectorsApiDiscover = useFeatureFlag(projectId, 'connectors_api_discover');
  const agentmailEmail = useFeatureFlag(projectId, 'agentmail_email');
  const metaAgent = useFeatureFlag(projectId, 'meta_agent');
  const monitors = useFeatureFlag(projectId, 'monitors');
  const reminders = useFeatureFlag(projectId, 'reminders');
  const warmSessions = useFeatureFlag(projectId, 'warm_sessions');
  const secretsEgress = useFeatureFlag(projectId, 'secrets_egress');
  const pooledProviderSecrets = useFeatureFlag(projectId, 'pooled_provider_secrets');
  const genui = useFeatureFlag(projectId, 'genui');
  const usRegion = useFeatureFlag(projectId, 'us_region');
  const eventTriggers = useFeatureFlag(projectId, 'event_triggers');
  const notificationCenter = useFeatureFlag(projectId, 'notification_center');
  const volumes = useFeatureFlag(projectId, 'volumes');
  const drives = useFeatureFlag(projectId, 'drives');
  const sessionLog = useFeatureFlag(projectId, 'session_log');
  const sessionLogRestore = useFeatureFlag(projectId, 'session_log_restore');
  const connectorsV2 = useFeatureFlag(projectId, 'connectors_v2');
  const agentRooms = useFeatureFlag(projectId, 'agent_rooms');
  const goals = useFeatureFlag(projectId, 'goals');

  return {
    flags: {
      marketplace: marketplace.enabled,
      connectors_api_discover: connectorsApiDiscover.enabled,
      agentmail_email: agentmailEmail.enabled,
      meta_agent: metaAgent.enabled,
      monitors: monitors.enabled,
      reminders: reminders.enabled,
      warm_sessions: warmSessions.enabled,
      secrets_egress: secretsEgress.enabled,
      pooled_provider_secrets: pooledProviderSecrets.enabled,
      genui: genui.enabled,
      us_region: usRegion.enabled,
      event_triggers: eventTriggers.enabled,
      notification_center: notificationCenter.enabled,
      volumes: volumes.enabled,
      drives: drives.enabled,
      session_log: sessionLog.enabled,
      session_log_restore: sessionLogRestore.enabled,
      connectors_v2: connectorsV2.enabled,
      agent_rooms: agentRooms.enabled,
      goals: goals.enabled,
    },
    // The trailing hook's loading state — keep this on the LAST hook above.
    isLoading: goals.isLoading,
  };
}
