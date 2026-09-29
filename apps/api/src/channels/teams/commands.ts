import { config } from '../../config';
import { formatRelativeTime, repoOgImage, sessionWebUrl } from '../slack/util';
import { projectRows } from './project-rows';
import { buildTeamsHomeCard } from './home';
import { lookupEmailsByUserIds } from '../../projects/lib/access';
import { currentChannelSelection } from '../slack/selection';
import { type SettingsChannel, changeChannelAgent, changeChannelPolicy, switchChannelProject, unbindChannel } from '../core/settings';
import { teamsAgentChangeText, teamsSettingsChannel, teamsSettingsRefusal } from './settings-text';
import { projectLlmGatewayEnabledById } from '../../llm-gateway/enablement';
import { buildAgentsPicker } from './agent-picker';
import { stopTeamsTurn } from './stop';
import { applyTeamsModelChoice, buildTeamsModelsCard, statusModel } from './model-choice';
import { messageAfterFreshStart, startFreshTeamsConversation } from './fresh-start';
import { createOrJoinTeamsConversationSession } from './session';
import { conversationPolicyLabel, normalizeConversationPolicy } from './participants';
import { sendCard } from '../teams-api';
import {
  type TeamsPanel,
  buildHelpCard,
  buildNoticeCard,
  buildPanelCard,
  buildProjectsCard as buildProjectsPickerCard,
  buildSessionsCard,
  openPanelAction,
} from './cards';
import { listVisibleChatSessions } from '../core/sessions';
import {
  conversationSession,
  type TeamsConversationSession,
  ensureTeamsConversationBinding,
  listTenantProjects,
  resolveConversationProject,
  teamsChannelCtx,
} from './binding';
import { teamsUserId } from './identity';
import { type ChatUser, chatUser, lookupChatIdentity, revokeChatIdentity } from '../core/identity';
import { teamsLoginCard } from './login-card';
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
  /** Per-project (BYO) bot: session lookups stay inside `projectId`. */
  projectScoped?: boolean;
}): Promise<boolean> {
  const ref = conversationRef(input.activity, input.projectId);
  const sessionProjectId = input.projectScoped ? input.projectId : undefined;
  if (!ref) return false;
  const { verb, arg } = input.command;
  const conversationId = ref.conversationId;
  const ctx = teamsChannelCtx(input.tenantId, conversationId);
  const userId = teamsUserId(input.activity);
  const actor = chatUser('teams', input.tenantId, userId ?? '');
  const settings = teamsSettingsChannel(input.activity, input.tenantId, conversationId);

  const post = (card: unknown) => sendCard(ref, card as Record<string, unknown>);

  try {
    switch (verb) {
      case 'login':
      case 'connect': {
        // The sign-in link only in a one-to-one chat (login-card.ts).
        if (userId) {
          await post(await teamsLoginCard({ activity: input.activity, tenantId: input.tenantId, teamsUserId: userId, projectId: input.projectId }));
        }
        return true;
      }
      case 'logout':
      case 'disconnect': {
        const revoked = userId ? await revokeChatIdentity(chatUser('teams', input.tenantId, userId)) : false;
        await post(buildNoticeCard(revoked ? 'Disconnected. Run `/login` to reconnect.' : "You weren't connected.", revoked ? '✅' : ''));
        return true;
      }
      case 'whoami':
      case 'who':
        await post(await buildWhoamiCard(ctx, input.activity, input.tenantId, conversationId, userId, input.projectId));
        return true;
      case 'help':
        await post(helpCard());
        return true;
      case 'stop':
      case 'cancel': {
        // The live card's Stop button is the primary lever; this is the one
        // that still works after the card has scrolled out of reach.
        const session = await conversationSession(input.tenantId, conversationId, sessionProjectId);
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
          projectId: sessionProjectId,
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
        await post(await buildStatusCard(ctx, input.tenantId, conversationId, input.projectId, userId, sessionProjectId));
        return true;
      case 'sessions':
        await post(await buildRecentSessionsCard(actor, sessionProjectId));
        return true;
      case 'home':
        await post(await buildTeamsHomeCard(input.tenantId, sessionProjectId));
        return true;
      case 'unbind': {
        // A per-project bot runs its own project in every conversation: there
        // is no binding to remove.
        if (sessionProjectId) {
          await post(buildNoticeCard('This bot always runs its own project, so there is nothing to unbind.'));
          return true;
        }
        const result = await unbindChannel(actor, settings);
        await post(
          result.ok
            ? buildNoticeCard('Unbound. The next message here picks the project again.', '✅')
            : buildNoticeCard(teamsSettingsRefusal(result.reason, '')),
        );
        return true;
      }
      case 'models':
        await ensureBinding(input.tenantId, conversationId, input.projectId, input.activity);
        await post(await buildTeamsModelsCard(input.activity, input.tenantId, conversationId));
        return true;
      case 'model':
        await ensureBinding(input.tenantId, conversationId, input.projectId, input.activity);
        await post(
          arg.trim()
            ? await applyTeamsModelChoice(input.activity, input.tenantId, conversationId, arg, sessionProjectId)
            : await buildTeamsModelsCard(input.activity, input.tenantId, conversationId),
        );
        return true;
      case 'agents':
        await ensureBinding(input.tenantId, conversationId, input.projectId, input.activity);
        await post(await buildAgentsPicker(ctx, input.projectId, undefined, userId));
        return true;
      case 'agent':
        await ensureBinding(input.tenantId, conversationId, input.projectId, input.activity);
        await post(await setAgent(settings, actor, arg));
        return true;
      case 'projects':
        await post(await buildProjectsCard(input.tenantId, input.projectId));
        return true;
      case 'use':
      case 'switch':
        await post(await switchProject(actor, settings, arg));
        return true;
      case 'policy':
        await ensureBinding(input.tenantId, conversationId, input.projectId, input.activity);
        await post(await setPolicy(settings, actor, arg));
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
    { cmd: '/status', desc: 'show and change the project, agent and model' },
    { cmd: '/sessions', desc: 'your recent sessions started from Teams' },
    { cmd: '/models', desc: 'pick the model for this conversation' },
    { cmd: '/agents', desc: 'pick the agent for this conversation' },
    { cmd: '/projects', desc: 'list connected projects' },
    { cmd: '/use <name>', desc: 'point this conversation at another project' },
    { cmd: '/stop', desc: 'stop the run in progress here' },
    { cmd: '/new [message]', desc: 'start a new session in this chat' },
    { cmd: '/policy', desc: 'who may join sessions started here: open, owner, approval' },
    { cmd: '/unbind', desc: 'disconnect this conversation from its project' },
    { cmd: '/home', desc: 'your projects and what to try' },
  ]);
}

async function buildStatusCard(
  ctx: ReturnType<typeof teamsChannelCtx>,
  tenantId: string,
  conversationId: string,
  projectId: string,
  userId: string | null,
  sessionProjectId?: string,
) {
  const [selection, projects, session, gatewayOn, identity] = await Promise.all([
    currentChannelSelection(ctx),
    listTenantProjects(tenantId).catch(() => []),
    conversationSession(tenantId, conversationId, sessionProjectId).catch(() => null),
    projectLlmGatewayEnabledById(projectId).catch(() => true),
    userId ? lookupChatIdentity(chatUser('teams', tenantId, userId)).catch(() => null) : Promise.resolve(null),
  ]);
  const email = identity
    ? (await lookupEmailsByUserIds([identity.userId]).catch(() => null))?.get(identity.userId)
    : null;
  const projectName = projects.find((p) => p.projectId === projectId)?.name ?? projectId;
  return buildPanelCard({
    emoji: '⚙️',
    title: 'This conversation',
    rows: [
      { label: 'Project', value: projectName },
      { label: 'Agent', value: selection?.agentName || 'default' },
      { label: 'Model', value: statusModel(selection?.opencodeModel ?? null, session, gatewayOn) },
      { label: 'Policy', value: conversationPolicyLabel(normalizeConversationPolicy(selection?.conversationPolicy ?? null)) },
      // The run itself. `/status` was the one place a user looks to answer
      // "what is this conversation doing", and it answered everything except
      // that — so a run that had quietly stopped looked identical to one still
      // working.
      { label: 'Session', value: describeConversationSession(session) },
      { label: 'You', value: identity ? `connected as ${email || 'your Kortix account'}` : 'not connected — run /login' },
    ],
    // Slack's settings panel changes what it shows; this one only showed it.
    actions: [
      openPanelAction('Change model', 'models'),
      openPanelAction('Change agent', 'agents'),
      ...(projects.length > 1 ? [openPanelAction('Switch project', 'projects')] : []),
    ],
    // Deep-link to the run when there is one: the project page is a detour
    // from the thing the card is about.
    url: session
      ? sessionWebUrl(config.FRONTEND_URL, projectId, session.sessionId)
      : `${dashboardBase()}/projects/${projectId}`,
  });
}

/**
 * The picker a `/status` button opens: the card `/models`, `/agents` or
 * `/projects` posts, shown to the person who pressed it.
 */
export async function buildTeamsPanel(input: {
  panel: TeamsPanel;
  activity: TeamsActivity;
  tenantId: string;
  conversationId: string;
  projectId: string;
}): Promise<Record<string, unknown>> {
  const { panel, activity, tenantId, conversationId, projectId } = input;
  if (panel === 'models') return buildTeamsModelsCard(activity, tenantId, conversationId);
  if (panel === 'agents') {
    return buildAgentsPicker(teamsChannelCtx(tenantId, conversationId), projectId, undefined, teamsUserId(activity));
  }
  return buildProjectsCard(tenantId, projectId);
}

/** How many sessions `/sessions` lists. */
const RECENT_SESSIONS = 5;

async function buildRecentSessionsCard(actor: ChatUser, projectId?: string) {
  // Only sessions the linked Kortix account may open, as on the web; a
  // per-project bot lists its own project's only.
  const rows = await listVisibleChatSessions(actor, { limit: RECENT_SESSIONS, projectId });
  if (rows === null) return buildNoticeCard('Connect your Kortix account to see your recent sessions: run `/login`.', '🔑');
  if (rows.length === 0) return buildNoticeCard('No recent sessions from this Teams tenant yet. @-mention me with a task to start one.', '🗂️');
  return buildSessionsCard(rows.map((r) => ({
    title: r.title || 'Untitled session',
    projectName: r.projectName,
    status: SESSION_STATUS[r.status]?.label,
    when: formatRelativeTime(r.lastMessageAt),
    url: sessionWebUrl(config.FRONTEND_URL, r.projectId, r.sessionId),
    imageUrl: r.repoUrl ? repoOgImage(r.repoUrl) : null,
  })));
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
  activity: TeamsActivity,
  tenantId: string,
  conversationId: string,
  userId: string | null,
  projectId: string,
) {
  const identity = userId ? await lookupChatIdentity(chatUser('teams', tenantId, userId)) : null;
  if (!identity) return teamsLoginCard({ activity, tenantId, teamsUserId: userId ?? '', projectId });
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

async function setAgent(ctx: SettingsChannel, user: ChatUser, arg: string) {
  const name = arg.trim();
  if (!name) return buildAgentsPicker(ctx, (await currentChannelSelection(ctx))?.projectId ?? '');
  return buildNoticeCard(teamsAgentChangeText(await changeChannelAgent(user, ctx, name), name));
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

async function setPolicy(ctx: SettingsChannel, user: ChatUser, arg: string) {
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
  const result = await changeChannelPolicy(user, ctx, next);
  if (!result.ok) return buildNoticeCard(teamsSettingsRefusal(result.reason, 'Connect a project to this conversation first — try /projects.'), '📁');
  return buildNoticeCard(`Session policy set to **${conversationPolicyLabel(next)}**. New sessions started here use it.`, '✅');
}

async function buildProjectsCard(tenantId: string, currentProjectId: string) {
  const projects = await listTenantProjects(tenantId);
  if (projects.length === 0) {
    return buildNoticeCard('No Kortix projects are connected to this Teams tenant yet.', '📁');
  }
  return buildProjectsPickerCard(projectRows(projects, currentProjectId));
}


async function switchProject(user: ChatUser, channel: SettingsChannel, arg: string) {
  const tenantId = channel.teamId;
  const conversationId = channel.channelId;
  const projects = await listTenantProjects(tenantId);
  const q = arg.trim().toLowerCase();
  const match = q
    ? projects.find((p) => p.name.toLowerCase() === q || p.projectId === arg.trim())
    : null;
  if (!match) return buildProjectsCard(tenantId, (await resolveConversationProject(tenantId, conversationId)) ?? '');
  const result = await switchChannelProject(user, channel, match.projectId);
  if (!result.ok) {
    return buildNoticeCard(
      result.reason === 'not_installed'
        ? "That project isn't connected to this Teams tenant."
        : teamsSettingsRefusal(result.reason, ''),
    );
  }
  return buildNoticeCard(`This conversation now runs **${match.name}**.`);
}
