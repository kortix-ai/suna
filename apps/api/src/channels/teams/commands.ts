import { config } from '../../config';
import { formatRelativeTime, sessionWebUrl } from '../slack/util';
import { lookupEmailsByUserIds } from '../../projects/lib/access';
import { labelForModelRef } from '../../llm-gateway/models/picker';
import { projectLlmGatewayEnabledById } from '../../llm-gateway/enablement';
import {
  currentChannelSelection,
  loadProjectAgentGovernance,
  setChannelAgent,
  setChannelConversationPolicy,
} from '../slack/selection';
import { buildAgentsPicker } from './agent-picker';
import { stopTeamsTurn } from './stop';
import { applyTeamsModelChoice, buildTeamsModelsCard, statusModel } from './model-choice';
import { messageAfterFreshStart, startFreshTeamsConversation } from './fresh-start';
import { createOrJoinTeamsConversationSession } from './session';
import { conversationPolicyLabel, normalizeConversationPolicy } from './participants';
import { sendCard } from '../teams-api';
import {
  buildConnectAccountCard,
  buildHelpCard,
  buildNoticeCard,
  buildPanelCard,
  buildSelectCard,
  type SelectOption,
} from './cards';
import {
  conversationSession,
  type TeamsConversationSession,
  ensureTeamsConversationBinding,
  listTenantProjects,
  resolveConversationProject,
  setConversationProject,
  teamsChannelCtx,
} from './binding';
import { lookupTeamsIdentity, revokeTeamsIdentity, teamsUserId } from './identity';
import { buildTeamsLoginUrl } from './login';
import { conversationScope, describeTeamsConversation, type TeamsCommand } from './util';
import type { TeamsActivity, TeamsConversationRef } from './types';

export { parseTeamsCommand } from './util';

function conversationRef(activity: TeamsActivity, projectId?: string): TeamsConversationRef | null {
  if (!activity.serviceUrl || !activity.conversation?.id) return null;
  return {
    serviceUrl: activity.serviceUrl,
    conversationId: activity.conversation.id,
    botId: activity.recipient?.id,
    fromId: activity.from?.id,
    tenantId: activity.conversation.tenantId ?? activity.channelData?.tenant?.id,
    projectId,
  };
}

function dashboardBase(): string {
  return (config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '');
}

export async function handleTeamsCommand(input: {
  command: TeamsCommand;
  activity: TeamsActivity;
  tenantId: string;
  projectId: string;
}): Promise<boolean> {
  const ref = conversationRef(input.activity, input.projectId);
  if (!ref) return false;
  const { verb, arg } = input.command;
  const conversationId = ref.conversationId;
  const ctx = teamsChannelCtx(input.tenantId, conversationId);
  const userId = teamsUserId(input.activity);

  const post = (card: unknown) => sendCard(ref, card as Record<string, unknown>);

  try {
    switch (verb) {
      case 'login':
      case 'connect': {
        if (userId) {
          await post(buildConnectAccountCard(buildTeamsLoginUrl({ tenantId: input.tenantId, teamsUserId: userId })));
        }
        return true;
      }
      case 'logout':
      case 'disconnect': {
        const revoked = userId ? await revokeTeamsIdentity(input.tenantId, userId) : false;
        await post(buildNoticeCard(revoked ? 'Disconnected. Run `/login` to reconnect.' : "You weren't connected.", revoked ? '✅' : ''));
        return true;
      }
      case 'whoami':
      case 'who':
        await post(await buildWhoamiCard(ctx, input.tenantId, conversationId, userId, input.projectId));
        return true;
      case 'help':
        await post(helpCard());
        return true;
      case 'stop':
      case 'cancel': {
        // The live card's Stop button is the primary lever; this is the one
        // that still works after the card has scrolled out of reach.
        const session = await conversationSession(input.tenantId, conversationId);
        if (!session) {
          await post(buildNoticeCard('Nothing is running in this conversation.'));
          return true;
        }
        const outcome = await stopTeamsTurn({
          sessionId: session.sessionId,
          teamsUserId: userId ?? '',
          byName: input.activity.from?.name,
        });
        await post(
          outcome.stopped
            ? buildNoticeCard(
                outcome.stoppedRuntime
                  ? 'Stopped. The agent is no longer working on this.'
                  : 'Stopped. The run was already closing on its own.',
                '✅',
              )
            : buildNoticeCard(outcome.notice),
        );
        return true;
      }
      case 'new':
      case 'reset': {
        // A chat is one conversation id for life, so without this every task
        // anyone ever asked shared one session. The old one stays in Kortix.
        const selection = await currentChannelSelection(ctx);
        const outcome = await startFreshTeamsConversation({
          tenantId: input.tenantId,
          conversationId,
          scope: conversationScope(input.activity),
          teamsUserId: userId ?? '',
          channelPolicy: selection?.conversationPolicy ?? null,
        });
        if (!outcome.reset) {
          await post(buildNoticeCard(outcome.notice));
          return true;
        }
        const message = messageAfterFreshStart(input.activity);
        const previous = outcome.previousSessionId
          ? ` The previous session stays in Kortix — [open it](${sessionWebUrl(config.FRONTEND_URL, input.projectId, outcome.previousSessionId)}).`
          : '';
        await post(
          buildNoticeCard(
            message ? `Starting a new session.${previous}` : `Your next message starts a new session.${previous}`,
            '✅',
          ),
        );
        if (message) {
          await createOrJoinTeamsConversationSession({
            projectId: input.projectId,
            tenantId: input.tenantId,
            conversationId,
            activity: { ...input.activity, text: message, id: `${input.activity.id ?? 'new'}:new` },
          });
        }
        return true;
      }
      case 'status':
      case 'config':
      case 'settings':
        await post(await buildStatusCard(ctx, input.tenantId, conversationId, input.projectId));
        return true;
      case 'models':
        await ensureBinding(input.tenantId, conversationId, input.projectId, input.activity);
        await post(await buildTeamsModelsCard(input.activity, input.tenantId, conversationId));
        return true;
      case 'model':
        await ensureBinding(input.tenantId, conversationId, input.projectId, input.activity);
        await post(
          arg.trim()
            ? await applyTeamsModelChoice(input.activity, input.tenantId, conversationId, arg)
            : await buildTeamsModelsCard(input.activity, input.tenantId, conversationId),
        );
        return true;
      case 'agents':
        await ensureBinding(input.tenantId, conversationId, input.projectId, input.activity);
        await post(await buildAgentsPicker(ctx, input.projectId, undefined, userId));
        return true;
      case 'agent':
        await ensureBinding(input.tenantId, conversationId, input.projectId, input.activity);
        await post(await setAgent(ctx, arg));
        return true;
      case 'projects':
        await post(await buildProjectsCard(input.tenantId, input.projectId));
        return true;
      case 'use':
      case 'switch':
        await post(await switchProject(input.tenantId, conversationId, arg));
        return true;
      case 'policy':
        await ensureBinding(input.tenantId, conversationId, input.projectId, input.activity);
        await post(await setPolicy(ctx, arg));
        return true;
      default:
        return false;
    }
  } catch (err) {
    console.error('[teams-command] failed', { verb, message: (err as Error)?.message });
    await post(buildNoticeCard('Something went wrong running that command — give it a moment and try again.', '⚠️')).catch(() => {});
    return true;
  }
}

async function ensureBinding(
  tenantId: string,
  conversationId: string,
  projectId: string,
  activity?: TeamsActivity,
): Promise<void> {
  await ensureTeamsConversationBinding({
    tenantId,
    conversationId,
    projectId,
    ...(activity ? describeTeamsConversation(activity) : {}),
  });
}

function helpCard() {
  return buildHelpCard([
    { cmd: '/login', desc: 'connect your Kortix account' },
    { cmd: '/logout', desc: 'disconnect your account' },
    { cmd: '/whoami', desc: 'show who you are linked as' },
    { cmd: '/status', desc: 'show the effective project, agent and model' },
    { cmd: '/models', desc: 'pick the model for this conversation' },
    { cmd: '/agents', desc: 'pick the agent for this conversation' },
    { cmd: '/projects', desc: 'list connected projects' },
    { cmd: '/use <name>', desc: 'point this conversation at another project' },
    { cmd: '/stop', desc: 'stop the run in progress here' },
    { cmd: '/new [message]', desc: 'start a new session in this chat' },
    { cmd: '/policy', desc: 'who may join sessions started here: open, owner, approval' },
  ]);
}

async function buildStatusCard(
  ctx: ReturnType<typeof teamsChannelCtx>,
  tenantId: string,
  conversationId: string,
  projectId: string,
) {
  const [selection, projects, session, gatewayOn] = await Promise.all([
    currentChannelSelection(ctx),
    listTenantProjects(tenantId).catch(() => []),
    conversationSession(tenantId, conversationId).catch(() => null),
    projectLlmGatewayEnabledById(projectId).catch(() => true),
  ]);
  const projectName = projects.find((p) => p.projectId === projectId)?.name ?? projectId;
  return buildPanelCard({
    emoji: '⚙️',
    title: 'This conversation',
    rows: [
      { label: 'Project', value: projectName },
      { label: 'Agent', value: selection?.agentName || 'default' },
      { label: 'Model', value: statusModel(selection?.opencodeModel ?? null, session, gatewayOn) },
      // The run itself. `/status` was the one place a user looks to answer
      // "what is this conversation doing", and it answered everything except
      // that — so a run that had quietly stopped looked identical to one still
      // working.
      { label: 'Session', value: describeConversationSession(session) },
    ],
    // Deep-link to the run when there is one: the project page is a detour
    // from the thing the card is about.
    url: session
      ? sessionWebUrl(config.FRONTEND_URL, projectId, session.sessionId)
      : `${dashboardBase()}/projects/${projectId}`,
  });
}

/**
 * Every value of `project_session_status`, as a glyph and a word a user reads.
 *
 * The first cut of this map keyed on `idle`, which is not one of them — so it
 * never matched, and `queued`, `branching`, `provisioning` and `completed` all
 * fell through to a bare `•`. The enum is the contract
 * (packages/db/src/schema/kortix.ts): queued, branching, provisioning, running,
 * stopped, failed, completed.
 *
 * `branching` and `provisioning` are how the sandbox is built, not something a
 * user asked about; both read as "starting". A status outside the enum still
 * renders, verbatim, rather than being swallowed.
 */
const SESSION_STATUS: Record<string, { glyph: string; label: string }> = {
  queued: { glyph: '•', label: 'queued' },
  branching: { glyph: '•', label: 'starting' },
  provisioning: { glyph: '•', label: 'starting' },
  running: { glyph: '⏳', label: 'working' },
  completed: { glyph: '✓', label: 'done' },
  stopped: { glyph: '•', label: 'stopped' },
  failed: { glyph: '✗', label: 'failed' },
};

function describeConversationSession(session: TeamsConversationSession | null): string {
  if (!session) return 'none yet — @-mention me with a task';
  const raw = session.status ?? '';
  const known = SESSION_STATUS[raw];
  const glyph = known?.glyph ?? '•';
  const label = known?.label ?? raw ?? 'unknown';
  const when = session.createdAt ? ` · started ${formatRelativeTime(session.createdAt)}` : '';
  return `${glyph} ${label}${when}`;
}

async function buildWhoamiCard(
  ctx: ReturnType<typeof teamsChannelCtx>,
  tenantId: string,
  conversationId: string,
  userId: string | null,
  projectId: string,
) {
  const identity = userId ? await lookupTeamsIdentity(tenantId, userId) : null;
  if (!identity) {
    return buildConnectAccountCard(
      buildTeamsLoginUrl({ tenantId, teamsUserId: userId ?? '' }),
    );
  }
  const email = (await lookupEmailsByUserIds([identity.userId]).catch(() => null))?.get(identity.userId);
  return buildPanelCard({
    emoji: '👤',
    title: 'You',
    rows: [
      { label: 'Connected as', value: email || identity.userId },
      { label: 'Runs act as', value: 'you — your credentials & secrets' },
    ],
    url: `${dashboardBase()}/projects/${projectId}`,
  });
}

async function setAgent(ctx: ReturnType<typeof teamsChannelCtx>, arg: string) {
  const name = arg.trim();
  if (!name) return buildAgentsPicker(ctx, (await currentChannelSelection(ctx))?.projectId ?? '');
  if (name.toLowerCase() === 'default') {
    await setChannelAgent(ctx, null);
    return buildNoticeCard('Agent reset to the project default.');
  }
  const res = await setChannelAgent(ctx, name);
  if (!res.ok && res.reason === 'unknown_agent') {
    return buildNoticeCard(`\`${name}\` isn't a declared agent in this project. Try /agents.`);
  }
  if (!res.ok) return buildNoticeCard('Connect a project to this conversation first.');
  return buildNoticeCard(`Agent set to ${name}. New sessions will use it.`);
}

const POLICY_ALIASES: Record<string, 'project_open' | 'owner_only' | 'owner_approval'> = {
  open: 'project_open',
  project_open: 'project_open',
  members: 'project_open',
  owner: 'owner_only',
  owner_only: 'owner_only',
  private: 'owner_only',
  approval: 'owner_approval',
  owner_approval: 'owner_approval',
  approve: 'owner_approval',
};

async function setPolicy(ctx: ReturnType<typeof teamsChannelCtx>, arg: string) {
  const selection = await currentChannelSelection(ctx);
  if (!selection) return buildNoticeCard('Connect a project to this conversation first — try /projects.', '📁');
  const current = normalizeConversationPolicy(selection.conversationPolicy);
  const requested = arg.trim().toLowerCase();
  if (!requested) {
    return buildPanelCard({
      emoji: '🔒',
      title: 'Session policy',
      rows: [
        { label: 'Current', value: conversationPolicyLabel(current) },
        { label: 'open', value: 'linked project members can join sessions started here (default)' },
        { label: 'approval', value: 'the session owner approves each person' },
        { label: 'owner', value: 'only the session owner' },
      ],
    });
  }
  const next = POLICY_ALIASES[requested];
  if (!next) return buildNoticeCard('Use `/policy open`, `/policy approval`, or `/policy owner`.');
  const ok = await setChannelConversationPolicy(ctx, next);
  if (!ok) return buildNoticeCard('Connect a project to this conversation first — try /projects.', '📁');
  return buildNoticeCard(`Session policy set to **${conversationPolicyLabel(next)}**. New sessions started here use it.`, '✅');
}

async function buildProjectsCard(tenantId: string, currentProjectId: string) {
  const projects = await listTenantProjects(tenantId);
  if (projects.length === 0) {
    return buildNoticeCard('No Kortix projects are connected to this Teams tenant yet.', '📁');
  }
  const options: SelectOption[] = projects.slice(0, 8).map((p) => ({
    label: p.name,
    current: p.projectId === currentProjectId,
    data: { projectId: p.projectId },
  }));
  return buildSelectCard({
    emoji: '📁',
    title: 'Connected projects',
    subtitle: 'Pick which project this conversation runs.',
    verb: 'teams_pick_project',
    options,
  });
}

async function switchProject(tenantId: string, conversationId: string, arg: string) {
  const projects = await listTenantProjects(tenantId);
  const q = arg.trim().toLowerCase();
  const match = q
    ? projects.find((p) => p.name.toLowerCase() === q || p.projectId === arg.trim())
    : null;
  if (!match) return buildProjectsCard(tenantId, (await resolveConversationProject(tenantId, conversationId)) ?? '');
  await setConversationProject({ tenantId, conversationId, projectId: match.projectId });
  return buildNoticeCard(`This conversation now runs **${match.name}**.`);
}
