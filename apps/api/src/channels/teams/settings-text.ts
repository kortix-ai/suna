import { config } from '../../config';
import type { SettingsChannel, SettingsRefusal, changeChannelAgent } from '../core/settings';
import { teamsChannelCtx } from './binding';
import type { TeamsActivity } from './types';
import { isPersonalChat } from './util';

// The Teams wording for channel-setting outcomes (core/settings.ts decides
// them), shared by the commands and the card buttons.

/**
 * The reply for a refused settings change, shared by the commands and the
 * card buttons. `noBinding` is the surface's own "connect a project" text.
 */
export function teamsSettingsRefusal(reason: SettingsRefusal, noBinding: string): string {
  switch (reason) {
    case 'unlinked':
      return config.TEAMS_REQUIRE_USER_IDENTITY
        ? 'Connect your Kortix account first — run `/login`. Settings change only for a linked project manager.'
        : "Change this conversation's settings in Kortix: Teams account linking is off on this server.";
    case 'forbidden':
      return "Only a project manager, or an account owner or admin, can change this conversation's settings.";
    case 'no_binding':
      return noBinding;
  }
}

/** The reply for an agent change, shared by `/agent` and the agent picker card. */
export function teamsAgentChangeText(result: Awaited<ReturnType<typeof changeChannelAgent>>, requested: string): string {
  if (result.ok) return result.agent ? `Agent set to ${result.agent}. New sessions will use it.` : 'Agent reset to the project default.';
  if (result.reason === 'unknown_agent') return `\`${requested}\` isn't a declared agent in this project. Try /agents.`;
  return teamsSettingsRefusal(result.reason, 'Connect a project to this conversation first.');
}

/** A Teams conversation for settings: a personal chat with the bot is one-to-one. */
export function teamsSettingsChannel(activity: TeamsActivity, tenantId: string, conversationId: string): SettingsChannel {
  return { ...teamsChannelCtx(tenantId, conversationId), oneToOne: isPersonalChat(activity) };
}
