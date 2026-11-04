import type { SlackPersona } from '../slack-api';
import { sessionAgentName } from '../core/session-agent';
import { ensureSlackBotId } from '../install-store';

/** Slack caps a message author name at 80 characters. */
const MAX_USERNAME = 80;

/** The Slack author for messages a Kortix agent writes; none for a blank name. */
export function slackPersonaFor(agentName: string | null | undefined): SlackPersona | null {
  const name = agentName?.trim();
  return name ? { username: name.slice(0, MAX_USERNAME) } : null;
}

/**
 * The session's agent as the author of its Slack messages. None before a
 * session exists, so a pre-launch refusal reads "Kortix".
 *
 * None either until the install's bot id is known: a post under another name
 * comes back with no `event.user`, and `isOwnBotEvent` then recognizes it by
 * that bot id. Without it the post goes out as plain "Kortix" so the self-loop
 * guard can never miss our own message.
 */
export async function slackAgentPersona(turn: {
  sessionId: string | null | undefined;
  projectId: string;
  token: string;
}): Promise<SlackPersona | null> {
  const persona = slackPersonaFor(await sessionAgentName(turn.sessionId));
  if (!persona) return null;
  return (await ensureSlackBotId(turn.projectId, turn.token)) ? persona : null;
}
