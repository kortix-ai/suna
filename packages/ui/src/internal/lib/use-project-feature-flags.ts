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
 * `volumes`, `drives` and `artifacts` graduated but are still served: each
 * reads whether the platform stores Files (Platinum).
 *
 * Fail-closed: every member is `false` until the project detail resolves.
 */
export function useProjectFeatureFlags(projectId: string | null | undefined): {
  flags: Partial<Record<FeatureFlagKey, boolean>>;
  isLoading: boolean;
} {
  const marketplace = useFeatureFlag(projectId, 'marketplace');
  const reminders = useFeatureFlag(projectId, 'reminders');
  const secretsEgress = useFeatureFlag(projectId, 'secrets_egress');
  const pooledProviderSecrets = useFeatureFlag(projectId, 'pooled_provider_secrets');
  const usRegion = useFeatureFlag(projectId, 'us_region');
  const eventTriggers = useFeatureFlag(projectId, 'event_triggers');
  const volumes = useFeatureFlag(projectId, 'volumes');
  const drives = useFeatureFlag(projectId, 'drives');
  const sessionLog = useFeatureFlag(projectId, 'session_log');
  const chat = useFeatureFlag(projectId, 'chat');
  const sharedDrives = useFeatureFlag(projectId, 'shared_drives');
  const goals = useFeatureFlag(projectId, 'goals');
  const artifacts = useFeatureFlag(projectId, 'artifacts');
  const emailChannel = useFeatureFlag(projectId, 'email_channel');
  const workspaceVolume = useFeatureFlag(projectId, 'workspace_volume');
  const sessionGroups = useFeatureFlag(projectId, 'session_groups');
  const chrome = useFeatureFlag(projectId, 'chrome');
  const agentTeams = useFeatureFlag(projectId, 'agent_teams');
  const voiceCall = useFeatureFlag(projectId, 'voice_call');
  const chatInput = useFeatureFlag(projectId, 'chat_input');
  const chatFront = useFeatureFlag(projectId, 'chat_front');
  const spacesProactive = useFeatureFlag(projectId, 'spaces_proactive');

  return {
    flags: {
      marketplace: marketplace.enabled,
      reminders: reminders.enabled,
      secrets_egress: secretsEgress.enabled,
      pooled_provider_secrets: pooledProviderSecrets.enabled,
      us_region: usRegion.enabled,
      event_triggers: eventTriggers.enabled,
      volumes: volumes.enabled,
      drives: drives.enabled,
      session_log: sessionLog.enabled,
      chat: chat.enabled,
      shared_drives: sharedDrives.enabled,
      goals: goals.enabled,
      artifacts: artifacts.enabled,
      email_channel: emailChannel.enabled,
      workspace_volume: workspaceVolume.enabled,
      session_groups: sessionGroups.enabled,
      chrome: chrome.enabled,
      agent_teams: agentTeams.enabled,
      voice_call: voiceCall.enabled,
      chat_input: chatInput.enabled,
      chat_front: chatFront.enabled,
      spaces_proactive: spacesProactive.enabled,
    },
    // The trailing hook's loading state — keep this on the LAST hook above.
    isLoading: spacesProactive.isLoading,
  };
}
