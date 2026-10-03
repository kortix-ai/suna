import { decodeHtmlEntities } from './markdown';

/**
 * One line, no mention markup: for command parsing and session titles. Never
 * for what the agent reads — see `teamsMessageText`.
 */
export function stripTeamsMentions(text: string): string {
  return text
    .replace(/<at[^>]*>.*?<\/at>/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The message as the agent should read it.
 *
 * The prompt used `stripTeamsMentions`, which collapses every run of
 * whitespace — so a pasted stack trace, list or code block reached the agent
 * as one line — and deletes EVERY mention, so "ask @Alice about it" reached it
 * as "ask about it". Here the line breaks stay, the bot's own mention (which
 * only addresses the message) goes, and anyone else mentioned stays by name.
 *
 * Which `<at>` is the bot comes from the mention entities. A message without
 * them (a synthetic one, relayed from a card) drops only a leading mention,
 * the way people address a bot.
 */
export function teamsMessageText(activity: {
  text?: string;
  entities?: Array<Record<string, unknown>>;
  recipient?: { id?: string };
}): string {
  const botId = activity.recipient?.id;
  const botMarkup = new Set<string>();
  let knowsMentions = false;
  for (const entity of activity.entities ?? []) {
    if (entity.type !== 'mention') continue;
    knowsMentions = true;
    const mentioned = entity.mentioned as { id?: string } | undefined;
    if (botId && mentioned?.id === botId && typeof entity.text === 'string') botMarkup.add(entity.text);
  }

  // A removed mention becomes one space, however much space surrounded it.
  const GAP = '\u0000';
  let text = (activity.text ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').replace(/<br\s*\/?>/gi, '\n');
  if (!knowsMentions) text = text.replace(/^\s*<at[^>]*>.*?<\/at>/i, GAP);
  text = text
    .replace(/<at[^>]*>(.*?)<\/at>/gi, (markup: string, name: string) =>
      botMarkup.has(markup) ? GAP : `@${name.trim()}`,
    )
    .replace(/[ \t]*\u0000[ \t]*/g, ' ');

  return decodeHtmlEntities(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
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
  'new',
  'reset',
  'status',
  'config',
  'settings',
  'sessions',
  'home',
  'unbind',
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

/** What Teams calls the channel every team starts with; it arrives without a name. */
export const TEAMS_GENERAL_CHANNEL = 'General';

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
 * A one-to-one chat with the bot, by Teams' own word only. `conversationScope`
 * falls back to `personal` for a missing type; a decision that makes a
 * session private or spends one person's keys must not.
 */
export function isPersonalChat(activity: { conversation?: { conversationType?: string } }): boolean {
  return (activity.conversation?.conversationType ?? '').toLowerCase() === 'personal';
}

/** A channel thread's conversation id: `19:…@thread.tacv2;messageid=…`. */
export function isTeamsChannelThreadId(conversationId: string): boolean {
  return conversationId.startsWith('19:') && conversationId.includes(';messageid=');
}

/** The channel a channel conversation lives in: its id, without `;messageid=…`. */
export function teamsChannelRoot(activity: {
  conversation?: { id?: string };
  channelData?: { channel?: { id?: string } };
}): string | undefined {
  return activity.channelData?.channel?.id || activity.conversation?.id?.split(';')[0] || undefined;
}

/**
 * What to call this conversation in the bindings table. Teams conversation ids
 * (`19:…@thread.tacv2;messageid=…`, `a:1FQyR…`) mean nothing to a person; the
 * team + channel name, "Group chat", or the person's name do.
 *
 * A channel is named only when the activity says which team: a message
 * carries the team's id but rarely its name, and a bare channel name would
 * overwrite a stored `Team › Channel`. `labelTeamsChannelBinding` asks Teams
 * for the rest.
 */
export function describeTeamsConversation(activity: {
  conversation?: { conversationType?: string; name?: string; id?: string };
  channelData?: { team?: { id?: string; name?: string }; channel?: { id?: string; name?: string } };
  from?: { name?: string };
}): { channelName?: string; channelType: TeamsConversationScope } {
  const scope = conversationScope(activity);
  if (scope === 'channel') {
    const team = activity.channelData?.team?.name?.trim();
    const teamId = activity.channelData?.team?.id;
    // The General channel's id is the team's id, and it arrives without a name.
    const channel =
      activity.channelData?.channel?.name?.trim() ||
      activity.conversation?.name?.trim() ||
      (teamId && teamsChannelRoot(activity) === teamId ? TEAMS_GENERAL_CHANNEL : undefined);
    return team && channel ? { channelName: `${team} › ${channel}`, channelType: scope } : { channelType: scope };
  }
  if (scope === 'groupChat') {
    return { channelName: activity.conversation?.name?.trim() || 'Group chat', channelType: scope };
  }
  return { channelName: activity.from?.name?.trim() || 'Personal chat', channelType: scope };
}
