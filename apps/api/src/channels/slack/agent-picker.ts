import { scopedProjectAgents } from '../scoped-agents';
import { chatUser, lookupChatIdentity } from '../core/identity';
import { escapeMrkdwn } from './util';

// The Slack agent picker, in both of its moods: `/kortix agents` and the
// session-start recovery picker when a channel's agent no longer exists. Its
// own module so session.ts can post the recovery picker without pulling in the
// whole command surface (teams/agent-picker.ts is the Teams twin).

/**
 * The project's launchable agents (git-backed catalog), filtered to what THIS
 * caller may see: a linked member sees only agents they're scoped to; an
 * unlinked caller sees only project-wide (unscoped) agents — never leak a scoped
 * agent's name cross-department. No-op when nothing is scoped. Touches git, so
 * callers must be off the synchronous 3s slash window. Shared by the `/kortix
 * agents` picker and the session-start "agent no longer exists" recovery picker
 * (session.ts) so both list the same scoped catalog.
 */
export async function loadScopedChannelAgents(input: {
  teamId: string;
  projectId: string;
  slackUserId?: string;
}): Promise<Array<{ name: string; description: string | null }>> {
  const identity = input.slackUserId
    ? await lookupChatIdentity(chatUser('slack', input.teamId, input.slackUserId))
    : null;
  return scopedProjectAgents(input.projectId, identity?.userId ?? null);
}

export function buildAgentPickerBlocks(
  channelId: string,
  currentAgent: string | null,
  agents: Array<{ name: string; description: string | null }>,
  // Override the default "Agents" header + "Pick which agent…" caption — e.g. the
  // session-start recovery picker leads with the failure it's recovering from.
  lead?: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  // `default` is the always-available implicit agent. Listed first.
  const rows: Array<{ name: string; description: string | null }> = [
    { name: 'default', description: 'The project\'s default agent.' },
    ...agents.filter((a) => a.name !== 'default'),
  ];
  const current = currentAgent ?? 'default';
  const blocks: Array<Record<string, unknown>> = lead
    ? [...lead]
    : [
        { type: 'header', text: { type: 'plain_text', text: 'Agents', emoji: true } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `Pick which agent answers in this channel. Current: *${escapeMrkdwn(current)}*` }] },
      ];
  for (const a of rows) {
    const isCurrent = a.name === current;
    const value = JSON.stringify({ c: channelId, a: a.name === 'default' ? '' : a.name });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${isCurrent ? '✓ ' : ''}*${escapeMrkdwn(a.name)}*${a.description ? `\n_${escapeMrkdwn(a.description.slice(0, 140))}_` : ''}` },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: isCurrent ? '✓ Current' : 'Use this', emoji: true },
        style: isCurrent ? undefined : 'primary',
        action_id: `set_agent_${a.name === 'default' ? 'default' : a.name}`.slice(0, 250),
        value,
      },
    });
  }
  return blocks;
}

/**
 * In-thread recovery blocks for when a Slack turn can't start because the agent
 * configured for the channel (a channel override, or the project default the
 * `default` sentinel resolves to) no longer exists — deleted, renamed, or
 * disabled. Names the dead agent, then offers an inline picker of the project's
 * CURRENT agents; the `set_agent_*` buttons run the SAME handler as `/kortix
 * agents` (interactivity.ts → handleSetSelection), so one click re-points the
 * channel binding and the user just re-sends. `badAgent` null = the `default`
 * sentinel couldn't resolve (no channel override was set).
 */
export function buildAgentUnavailablePickerBlocks(input: {
  channelId: string;
  badAgent: string | null;
  agents: Array<{ name: string; description: string | null }>;
}): Array<Record<string, unknown>> {
  const bad = input.badAgent && input.badAgent.trim() ? input.badAgent.trim() : null;
  const lead = bad
    ? `:warning:  *I couldn't start a session — the agent set for this channel (\`${escapeMrkdwn(bad)}\`) no longer exists.*\nIt was deleted, renamed, or disabled. Pick one of this project's current agents below, then send your message again.`
    : `:warning:  *I couldn't start a session — this channel's default agent no longer exists.*\nIt was deleted, renamed, or disabled. Pick one of this project's current agents below, then send your message again.`;
  // Mark nothing as "current": the previously-selected agent is the dead one, so
  // implying an existing selection would be misleading. Pass the bad name as
  // `currentAgent` — it isn't in the list, so no row gets a ✓.
  return buildAgentPickerBlocks(input.channelId, bad, input.agents, [
    { type: 'section', text: { type: 'mrkdwn', text: lead } },
  ]);
}
