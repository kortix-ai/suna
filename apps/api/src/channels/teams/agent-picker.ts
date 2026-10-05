import { currentChannelSelection } from '../slack/selection';
import { scopedProjectAgents } from '../scoped-agents';
import { teamsChannelCtx } from './binding';
import { chatUser, lookupChatIdentity } from '../core/identity';
import { buildAgentPickerCard, buildNoticeCard } from './cards';

/**
 * The agent picker, in both of its moods.
 *
 * `/agents` asks for the neutral one. A failed session start asks for the
 * recovery one through `buildAgentUnavailableCard`.
 *
 * It lives in its own module rather than in `commands.ts` so that `session.ts`
 * can post the recovery card without pulling the whole command surface — and
 * the gateway model picker behind it — into the session-start path.
 */
export async function buildAgentsPicker(
  ctx: ReturnType<typeof teamsChannelCtx>,
  projectId: string,
  lead?: { title: string; subtitle: string },
  // The Teams user pressing this, so the list is scoped to what they may
  // actually run. Omitted means unlinked, which sees the unscoped set.
  teamsUserId?: string | null,
): Promise<Record<string, unknown>> {
  const identity =
    teamsUserId && ctx.teamId ? await lookupChatIdentity(chatUser('teams', ctx.teamId, teamsUserId)) : null;
  const [agents, selection] = await Promise.all([
    scopedProjectAgents(projectId, identity?.userId ?? null),
    currentChannelSelection(ctx),
  ]);
  if (agents.length === 0) {
    return buildNoticeCard(
      lead
        ? "I couldn't start a session — the agent set for this conversation no longer exists, and this project declares no other agent. Run `/agents default` to fall back to the project default, or declare an agent in `kortix.yaml`."
        : 'This project has no declared agents, so it runs the default agent. Declare agents in `kortix.yaml` to switch here.',
      '🤖',
    );
  }
  return buildAgentPickerCard({
    agents,
    current: selection?.agentName ?? null,
    lead,
  });
}

/**
 * The card a failed session start posts when the conversation's agent is gone.
 *
 * `createProjectSession` rejects a deleted / renamed / disabled agent up front
 * with `400 AGENT_NOT_DECLARED`, and no amount of retrying revives it — the
 * generic "give it a moment and send your message again" copy left the
 * conversation with no way out at all. Name the problem and hand over the same
 * picker `/agents` builds, so one tap re-points the conversation at a live
 * agent. Slack has had this since its own start-error sweep.
 */
export async function buildAgentUnavailableCard(input: {
  tenantId: string;
  conversationId: string;
  projectId: string;
  badAgent: string | null;
  teamsUserId?: string | null;
}): Promise<Record<string, unknown>> {
  return buildAgentsPicker(
    teamsChannelCtx(input.tenantId, input.conversationId),
    input.projectId,
    {
      title: "Couldn't start — pick an agent",
      subtitle: input.badAgent
        ? `The agent set for this conversation (${input.badAgent}) no longer exists.`
        : 'The agent set for this conversation no longer exists.',
    },
    input.teamsUserId,
  );
}
