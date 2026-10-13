/**
 * Channel messages in a session (Slack, Microsoft Teams, Telegram). The prompt
 * parser lives in `@kortix/shared` (`channel-message.ts`), shared with the
 * mobile app; this module adds what only web has: the project's Slack bindings,
 * which name a channel id.
 */

export { parseChannelMessage, type ChannelMessageInfo, type ChannelPlatform } from '@kortix/shared';

/**
 * A bound Slack conversation as a person reads it: `#general`, the other
 * person's name for a DM, the members of a group DM. Null until the API has
 * named it. A name stored before Slack types were recorded is a channel's.
 */
export function slackConversationName(binding: { channelName: string | null; channelType: string | null }): string | null {
  if (!binding.channelName) return null;
  return binding.channelType === 'im' || binding.channelType === 'mpim' ? binding.channelName : `#${binding.channelName}`;
}

/**
 * Bound Slack conversation ids mapped to the names `slackConversationName`
 * gives them. Rows of other platforms, and rows Slack has not named, are left
 * out: their ids show as they are.
 */
export function slackChannelNames(
  bindings: ReadonlyArray<{ platform: string; channelId: string; channelName: string | null; channelType: string | null }>,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const binding of bindings) {
    if (binding.platform !== 'slack') continue;
    const name = slackConversationName(binding);
    if (name) names.set(binding.channelId, name);
  }
  return names;
}
