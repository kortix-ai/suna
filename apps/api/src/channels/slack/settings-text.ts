import { config } from '../../config';
import { type ChatUser, chatUser } from '../core/identity';
import type { SettingsChannel, SettingsRefusal } from '../core/settings';

// The Slack side of channel settings that every setter shares: who is asking,
// which channel it is, and the wording of a refusal (core/settings.ts decides
// it). teams/settings-text.ts is the Teams twin.

export function slackUserOf(ctx: { teamId: string; slackUserId: string }): ChatUser {
  return chatUser('slack', ctx.teamId, ctx.slackUserId);
}

/** A Slack channel for settings. DM channel ids start with `D`. */
export function slackSettingsChannel(ctx: { teamId: string; channelId: string }): SettingsChannel {
  return { teamId: ctx.teamId, channelId: ctx.channelId, oneToOne: ctx.channelId.startsWith('D') };
}

/**
 * The reply for a refused settings change. `noBinding` is the surface's own
 * "bind a project first" text.
 */
export function settingsRefusalText(reason: SettingsRefusal, command: string, noBinding: string): string {
  switch (reason) {
    case 'unlinked':
      return config.SLACK_REQUIRE_USER_IDENTITY
        ? `Connect your Kortix account first: \`${command} login\`. Channel settings change only for a linked project manager.`
        : "Change this channel's settings in Kortix: Slack account linking is off on this server.";
    case 'forbidden':
      return "Only a project manager, or an account owner or admin, can change this channel's settings.";
    case 'no_binding':
      return noBinding;
  }
}
