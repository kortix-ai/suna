import { config } from '../../config';
import { lookupEmailsByUserIds } from '../../workspaces/lib/access';
import { listPickerModels, labelForModelRef } from '../../llm-gateway/models/picker';
import { isModelServableForAccount } from '../../llm-gateway/resolution/default-model';
import { toOpencodeModelRef, toWireModel } from '../../llm-gateway/resolution/effective';
import { channelModelContext } from '../slack/model-gate';
import {
  currentChannelSelection,
  loadWorkspaceAgentGovernance,
  setChannelAgent,
  setChannelModel,
} from '../slack/selection';
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
  ensureTeamsConversationBinding,
  listTenantWorkspaces,
  resolveConversationWorkspace,
  setConversationWorkspace,
  teamsChannelCtx,
} from './binding';
import { lookupTeamsIdentity, revokeTeamsIdentity, teamsUserId } from './identity';
import { buildTeamsLoginUrl } from './login';
import { type TeamsCommand } from './util';
import type { TeamsActivity, TeamsConversationRef } from './types';

export { parseTeamsCommand } from './util';

function conversationRef(activity: TeamsActivity, workspaceId?: string): TeamsConversationRef | null {
  if (!activity.serviceUrl || !activity.conversation?.id) return null;
  return {
    serviceUrl: activity.serviceUrl,
    conversationId: activity.conversation.id,
    botId: activity.recipient?.id,
    fromId: activity.from?.id,
    tenantId: activity.conversation.tenantId ?? activity.channelData?.tenant?.id,
    workspaceId,
  };
}

function dashboardBase(): string {
  return (config.FRONTEND_URL || 'https://kortix.com').replace(/\/+$/, '');
}

export async function handleTeamsCommand(input: {
  command: TeamsCommand;
  activity: TeamsActivity;
  tenantId: string;
  workspaceId: string;
}): Promise<boolean> {
  const ref = conversationRef(input.activity, input.workspaceId);
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
        await post(await buildWhoamiCard(ctx, input.tenantId, conversationId, userId, input.workspaceId));
        return true;
      case 'help':
        await post(helpCard());
        return true;
      case 'status':
      case 'config':
      case 'settings':
        await post(await buildStatusCard(ctx, input.tenantId, conversationId, input.workspaceId));
        return true;
      case 'models':
        await ensureBinding(input.tenantId, conversationId, input.workspaceId);
        await post(await buildModelsCard(ctx));
        return true;
      case 'model':
        await ensureBinding(input.tenantId, conversationId, input.workspaceId);
        await post(await setModel(ctx, arg));
        return true;
      case 'agents':
        await ensureBinding(input.tenantId, conversationId, input.workspaceId);
        await post(await buildAgentsCard(ctx, input.workspaceId));
        return true;
      case 'agent':
        await ensureBinding(input.tenantId, conversationId, input.workspaceId);
        await post(await setAgent(ctx, arg));
        return true;
      case 'workspaces':
      case 'projects': // Legacy command alias.
        await post(await buildWorkspacesCard(input.tenantId, input.workspaceId));
        return true;
      case 'use':
      case 'switch':
        await post(await switchWorkspace(input.tenantId, conversationId, arg));
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

async function ensureBinding(tenantId: string, conversationId: string, workspaceId: string): Promise<void> {
  await ensureTeamsConversationBinding({ tenantId, conversationId, workspaceId });
}

function helpCard() {
  return buildHelpCard([
    { cmd: '/login', desc: 'connect your Kortix account' },
    { cmd: '/logout', desc: 'disconnect your account' },
    { cmd: '/whoami', desc: 'show who you are linked as' },
    { cmd: '/status', desc: 'show the effective workspace, agent and model' },
    { cmd: '/models', desc: 'pick the model for this conversation' },
    { cmd: '/agents', desc: 'pick the agent for this conversation' },
    { cmd: '/workspaces', desc: 'list connected workspaces' },
    { cmd: '/use <name>', desc: 'point this conversation at another workspace' },
  ]);
}

async function buildStatusCard(
  ctx: ReturnType<typeof teamsChannelCtx>,
  tenantId: string,
  conversationId: string,
  workspaceId: string,
) {
  const [selection, workspaces] = await Promise.all([
    currentChannelSelection(ctx),
    listTenantWorkspaces(tenantId).catch(() => []),
  ]);
  const workspaceName = workspaces.find((workspace) => workspace.workspaceId === workspaceId)?.name ?? workspaceId;
  return buildPanelCard({
    emoji: '⚙️',
    title: 'This conversation',
    rows: [
      { label: 'Workspace', value: workspaceName },
      { label: 'Agent', value: selection?.agentName || 'default' },
      { label: 'Model', value: selection?.opencodeModel ? labelForModelRef(selection.opencodeModel) : 'workspace default' },
    ],
    url: `${dashboardBase()}/workspaces/${workspaceId}`,
  });
}

async function buildWhoamiCard(
  ctx: ReturnType<typeof teamsChannelCtx>,
  tenantId: string,
  conversationId: string,
  userId: string | null,
  workspaceId: string,
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
    url: `${dashboardBase()}/workspaces/${workspaceId}`,
  });
}

async function buildModelsCard(ctx: ReturnType<typeof teamsChannelCtx>) {
  const gate = await channelModelContext(ctx);
  if (!gate) return buildNoticeCard('Connect a workspace to this conversation first — try /workspaces.', '📁');
  const selection = await currentChannelSelection(ctx);
  const current = selection?.opencodeModel ?? null;
  const isCurrent = (id: string) => !!current && toWireModel(current) === toWireModel(id);

  const { models, workspaceDefault } = await listPickerModels({
    workspaceId: gate.workspaceId,
    userId: gate.ownerUserId,
    accountId: gate.accountId,
    freeManagedOnly: gate.freeManagedOnly,
    agentName: selection?.agentName ?? null,
  });

  const options: SelectOption[] = [
    { label: 'Workspace default', hint: workspaceDefault.label ?? undefined, current: !current, data: { model: '' } },
    ...models.slice(0, 6).map((m) => ({
      label: m.label,
      hint: m.id,
      current: isCurrent(m.id),
      data: { model: m.id },
    })),
  ];

  return buildSelectCard({
    emoji: '🧠',
    title: 'Model',
    subtitle: current ? `Currently ${labelForModelRef(current)}` : 'Currently the workspace default',
    verb: 'teams_set_model',
    options,
    footer: 'Or set any provider/model-id you have connected in Kortix: `/model anthropic/claude-sonnet-4.6`.',
  });
}

async function setModel(ctx: ReturnType<typeof teamsChannelCtx>, arg: string) {
  const id = arg.trim();
  if (!id) return buildModelsCard(ctx);
  const gate = await channelModelContext(ctx);
  if (!gate) return buildNoticeCard('Connect a workspace to this conversation first.');
  if (id.toLowerCase() === 'default') {
    await setChannelModel(ctx, null);
    return buildNoticeCard('Model reset to the workspace default.');
  }
  const servable = await isModelServableForAccount({
    userId: gate.ownerUserId,
    accountId: gate.accountId,
    workspaceId: gate.workspaceId,
    freeModelsOnly: gate.freeManagedOnly,
    model: id,
  });
  if (!servable) {
    return buildNoticeCard(`\`${id}\` isn't available here. Pick one with /models or connect that provider in Kortix.`);
  }
  const stored = toOpencodeModelRef(id);
  await setChannelModel(ctx, stored);
  return buildNoticeCard(`Model set to ${labelForModelRef(stored)}. New sessions will use it.`);
}

async function buildAgentsCard(ctx: ReturnType<typeof teamsChannelCtx>, workspaceId: string) {
  const [governance, selection] = await Promise.all([
    loadWorkspaceAgentGovernance(workspaceId),
    currentChannelSelection(ctx),
  ]);
  const current = selection?.agentName ?? null;
  if (governance.agents.length === 0) {
    return buildNoticeCard(
      'This workspace has no declared agents, so it runs the default agent. Declare agents in `kortix.yaml` to switch here.',
      '🤖',
    );
  }
  const options: SelectOption[] = [
    { label: 'Default', current: !current, data: { agent: '' } },
    ...governance.agents.slice(0, 6).map((a) => ({
      label: a.name,
      hint: a.description ?? undefined,
      current: current === a.name,
      data: { agent: a.name },
    })),
  ];
  return buildSelectCard({
    emoji: '🤖',
    title: 'Agent',
    subtitle: current ? `Currently ${current}` : 'Currently the default agent',
    verb: 'teams_set_agent',
    options,
  });
}

async function setAgent(ctx: ReturnType<typeof teamsChannelCtx>, arg: string) {
  const name = arg.trim();
  if (!name) return buildAgentsCard(ctx, (await currentChannelSelection(ctx))?.workspaceId ?? '');
  if (name.toLowerCase() === 'default') {
    await setChannelAgent(ctx, null);
    return buildNoticeCard('Agent reset to the workspace default.');
  }
  const res = await setChannelAgent(ctx, name);
  if (!res.ok && res.reason === 'unknown_agent') {
    return buildNoticeCard(`\`${name}\` isn't a declared agent in this workspace. Try /agents.`);
  }
  if (!res.ok) return buildNoticeCard('Connect a workspace to this conversation first.');
  return buildNoticeCard(`Agent set to ${name}. New sessions will use it.`);
}

async function buildWorkspacesCard(tenantId: string, currentWorkspaceId: string) {
  const workspaces = await listTenantWorkspaces(tenantId);
  if (workspaces.length === 0) {
    return buildNoticeCard('No Kortix workspaces are connected to this Teams tenant yet.', '📁');
  }
  const options: SelectOption[] = workspaces.slice(0, 8).map((workspace) => ({
    label: workspace.name,
    current: workspace.workspaceId === currentWorkspaceId,
    data: { workspaceId: workspace.workspaceId },
  }));
  return buildSelectCard({
    emoji: '📁',
    title: 'Connected workspaces',
    subtitle: 'Pick which workspace this conversation runs.',
    verb: 'teams_pick_project',
    options,
  });
}

async function switchWorkspace(tenantId: string, conversationId: string, arg: string) {
  const workspaces = await listTenantWorkspaces(tenantId);
  const q = arg.trim().toLowerCase();
  const match = q
    ? workspaces.find((workspace) => workspace.name.toLowerCase() === q || workspace.workspaceId === arg.trim())
    : null;
  if (!match) return buildWorkspacesCard(tenantId, (await resolveConversationWorkspace(tenantId, conversationId)) ?? '');
  await setConversationWorkspace({ tenantId, conversationId, workspaceId: match.workspaceId });
  return buildNoticeCard(`This conversation now runs *${match.name}*.`);
}
