export function stripTeamsMentions(text: string): string {
  return text
    .replace(/<at[^>]*>.*?<\/at>/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface TeamsCommand {
  verb: string;
  arg: string;
}

const COMMAND_VERBS = new Set([
  'login',
  'connect',
  'logout',
  'disconnect',
  'whoami',
  'who',
  'help',
  'stop',
  'cancel',
  'status',
  'config',
  'settings',
  'models',
  'model',
  'agents',
  'agent',
  'projects',
  'use',
  'switch',
  'policy',
]);

export function parseTeamsCommand(text: string | undefined): TeamsCommand | null {
  const stripped = stripTeamsMentions(text ?? '').trim();
  if (!stripped.startsWith('/')) return null;
  const body = stripped.slice(1).trim();
  if (!body) return null;
  const [first, ...rest] = body.split(/\s+/);
  const verb = first.toLowerCase();
  if (!COMMAND_VERBS.has(verb)) return null;
  return { verb, arg: rest.join(' ').trim() };
}

/**
 * Whether this activity @-mentions the bot. Teams lists mentions in
 * `entities[]` with `type: 'mention'`; the bot is `activity.recipient`.
 */
export function isBotMentioned(activity: {
  entities?: Array<Record<string, unknown>>;
  recipient?: { id?: string };
}): boolean {
  const botId = activity.recipient?.id;
  if (!botId) return false;
  for (const entity of activity.entities ?? []) {
    if (entity.type !== 'mention') continue;
    const mentioned = entity.mentioned as { id?: string } | undefined;
    if (mentioned?.id === botId) return true;
  }
  return false;
}

export type TeamsConversationScope = 'personal' | 'groupChat' | 'channel';

/** Personal chats deliver every message to the bot; channels and group chats only mentions — unless RSC grants more. */
export function conversationScope(activity: {
  conversation?: { conversationType?: string };
}): TeamsConversationScope {
  const t = (activity.conversation?.conversationType ?? '').toLowerCase();
  if (t === 'channel') return 'channel';
  if (t === 'groupchat') return 'groupChat';
  return 'personal';
}

/**
 * What to call this conversation in the bindings table. Teams conversation ids
 * (`19:…@thread.tacv2;messageid=…`, `a:1FQyR…`) mean nothing to a person; the
 * team + channel name, "Group chat", or the person's name do.
 */
export function describeTeamsConversation(activity: {
  conversation?: { conversationType?: string; name?: string };
  channelData?: { team?: { name?: string }; channel?: { name?: string } };
  from?: { name?: string };
}): { channelName: string; channelType: TeamsConversationScope } {
  const scope = conversationScope(activity);
  if (scope === 'channel') {
    const team = activity.channelData?.team?.name?.trim();
    const channel = activity.channelData?.channel?.name?.trim() || activity.conversation?.name?.trim() || 'General';
    return { channelName: team ? `${team} › ${channel}` : channel, channelType: scope };
  }
  if (scope === 'groupChat') {
    return { channelName: activity.conversation?.name?.trim() || 'Group chat', channelType: scope };
  }
  return { channelName: activity.from?.name?.trim() || 'Personal chat', channelType: scope };
}
