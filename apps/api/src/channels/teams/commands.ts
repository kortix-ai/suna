import { config } from '../../config';
import { listPickerModels, labelForModelRef } from '../../llm-gateway/models/picker';
import { isModelServableForAccount } from '../../llm-gateway/resolution/default-model';
import { toOpencodeModelRef, toWireModel } from '../../llm-gateway/resolution/effective';
import { channelModelContext } from '../slack/model-gate';
import {
  currentChannelSelection,
  loadProjectAgentGovernance,
  setChannelAgent,
  setChannelModel,
} from '../slack/selection';
import { sendCard } from '../teams-api';
import {
  buildChoiceCard,
  buildConnectAccountCard,
  buildHelpCard,
  buildNoticeCard,
  buildPanelCard,
} from './cards';
import {
  ensureTeamsConversationBinding,
  listTenantProjects,
  resolveConversationProject,
  setConversationProject,
  teamsChannelCtx,
} from './binding';
import { lookupTeamsIdentity, revokeTeamsIdentity, teamsUserId } from './identity';
import { buildTeamsLoginUrl } from './login';
import { stripTeamsMentions } from './util';
import type { TeamsActivity, TeamsConversationRef } from './types';

const COMMAND_VERBS = new Set([
  'login',
  'connect',
  'logout',
  'disconnect',
  'whoami',
  'who',
  'help',
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
]);

export interface TeamsCommand {
  verb: string;
  arg: string;
}

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
  const conversationId = input.activity.conversation!.id!;
  const ctx = teamsChannelCtx(input.tenantId, conversationId);
  const userId = teamsUserId(input.activity);

  const post = (card: unknown) => sendCard(ref, card as Record<string, unknown>);

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
      await post(buildNoticeCard(revoked ? 'Disconnected. Run `/login` to reconnect.' : "You weren't connected."));
      return true;
    }
    case 'whoami':
    case 'who':
      await post(await buildWhoamiCard(ctx, input.tenantId, conversationId, userId, input.projectId));
      return true;
    case 'help':
      await post(helpCard());
      return true;
    case 'status':
    case 'config':
    case 'settings':
      await post(await buildStatusCard(ctx, input.tenantId, conversationId, input.projectId));
      return true;
    case 'models':
      await ensureBinding(input.tenantId, conversationId, input.projectId);
      await post(await buildModelsCard(ctx));
      return true;
    case 'model':
      await ensureBinding(input.tenantId, conversationId, input.projectId);
      await post(await setModel(ctx, arg));
      return true;
    case 'agents':
      await ensureBinding(input.tenantId, conversationId, input.projectId);
      await post(await buildAgentsCard(ctx, input.projectId));
      return true;
    case 'agent':
      await ensureBinding(input.tenantId, conversationId, input.projectId);
      await post(await setAgent(ctx, arg));
      return true;
    case 'projects':
      await post(await buildProjectsCard(input.tenantId, input.projectId));
      return true;
    case 'use':
    case 'switch':
      await post(await switchProject(input.tenantId, conversationId, arg));
      return true;
    default:
      return false;
  }
}

async function ensureBinding(tenantId: string, conversationId: string, projectId: string): Promise<void> {
  await ensureTeamsConversationBinding({ tenantId, conversationId, projectId });
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
  ]);
}

async function buildStatusCard(
  ctx: ReturnType<typeof teamsChannelCtx>,
  tenantId: string,
  conversationId: string,
  projectId: string,
) {
  const selection = await currentChannelSelection(ctx);
  const rows = [
    { label: 'Project', value: projectId },
    { label: 'Agent', value: selection?.agentName || 'default' },
    { label: 'Model', value: selection?.opencodeModel ? labelForModelRef(selection.opencodeModel) : 'project default' },
  ];
  return buildPanelCard({
    title: 'This conversation',
    rows,
    url: `${dashboardBase()}/projects/${projectId}`,
  });
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
  return buildStatusCard(ctx, tenantId, conversationId, projectId);
}

async function buildModelsCard(ctx: ReturnType<typeof teamsChannelCtx>) {
  const gate = await channelModelContext(ctx);
  if (!gate) return buildNoticeCard('Connect a project to this conversation first.');
  const selection = await currentChannelSelection(ctx);
  const current = selection?.opencodeModel ?? null;
  const isCurrent = (id: string) => !!current && toWireModel(current) === toWireModel(id);

  const { models, projectDefault } = await listPickerModels({
    projectId: gate.projectId,
    userId: gate.ownerUserId,
    accountId: gate.accountId,
    freeManagedOnly: gate.freeManagedOnly,
    agentName: selection?.agentName ?? null,
  });

  const choices = [
    {
      title: `${current ? '' : '✓ '}Project default${projectDefault.label ? ` · ${projectDefault.label}` : ''}`,
      data: { model: '' },
    },
    ...models.slice(0, 5).map((m) => ({
      title: `${isCurrent(m.id) ? '✓ ' : ''}${m.label}`,
      data: { model: m.id },
    })),
  ];

  return buildChoiceCard({
    title: 'Model for this conversation',
    verb: 'teams_set_model',
    body: current ? `Currently ${labelForModelRef(current)}.` : 'Currently the project default.',
    choices,
  });
}

async function setModel(ctx: ReturnType<typeof teamsChannelCtx>, arg: string) {
  const id = arg.trim();
  if (!id) return buildModelsCard(ctx);
  const gate = await channelModelContext(ctx);
  if (!gate) return buildNoticeCard('Connect a project to this conversation first.');
  if (id.toLowerCase() === 'default') {
    await setChannelModel(ctx, null);
    return buildNoticeCard('Model reset to the project default.');
  }
  const servable = await isModelServableForAccount({
    userId: gate.ownerUserId,
    accountId: gate.accountId,
    projectId: gate.projectId,
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

async function buildAgentsCard(ctx: ReturnType<typeof teamsChannelCtx>, projectId: string) {
  const governance = await loadProjectAgentGovernance(projectId);
  const selection = await currentChannelSelection(ctx);
  const current = selection?.agentName ?? null;
  if (governance.agents.length === 0) {
    return buildNoticeCard('This project has no declared agents — it runs the default agent.');
  }
  const choices = [
    { title: `${current ? '' : '✓ '}Default`, data: { agent: '' } },
    ...governance.agents.slice(0, 5).map((a) => ({
      title: `${current === a.name ? '✓ ' : ''}${a.name}`,
      data: { agent: a.name },
    })),
  ];
  return buildChoiceCard({ title: 'Agent for this conversation', verb: 'teams_set_agent', choices });
}

async function setAgent(ctx: ReturnType<typeof teamsChannelCtx>, arg: string) {
  const name = arg.trim();
  if (!name) return buildAgentsCard(ctx, (await currentChannelSelection(ctx))?.projectId ?? '');
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

async function buildProjectsCard(tenantId: string, currentProjectId: string) {
  const projects = await listTenantProjects(tenantId);
  if (projects.length === 0) return buildNoticeCard('No Kortix projects are connected to this Teams tenant yet.');
  const choices = projects.slice(0, 6).map((p) => ({
    title: `${p.projectId === currentProjectId ? '✓ ' : ''}${p.name}`,
    data: { projectId: p.projectId },
  }));
  return buildChoiceCard({
    title: 'Connected projects',
    verb: 'teams_pick_project',
    body: 'Pick which project this conversation runs.',
    choices,
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
  return buildNoticeCard(`This conversation now runs *${match.name}*.`);
}
