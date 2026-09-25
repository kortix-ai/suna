import { and, eq, inArray } from 'drizzle-orm';
import { chatChannelBindings, chatInstalls, projects } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import { lookupEmailsByUserIds } from '../../accounts/core/app';
import { listPickerModels, labelForModelRef } from '../../llm-gateway/models/picker';
import { resolveEffectiveModel } from '../../llm-gateway/resolution/default-model';
import { chooseEffectiveAgent, toWireModel } from '../../llm-gateway/resolution/effective';
import { type ChatUser, chatUser, lookupChatIdentity } from '../core/identity';
import {
  type SettingsRefusal,
  changeChannelAgent,
  changeChannelModel,
  changeChannelPolicy,
  unbindChannel,
} from '../core/settings';
import { buildAgentPickerBlocks, loadScopedChannelAgents } from './agent-picker';
import { channelModelContext } from './model-gate';
import { conversationPolicyLabel, normalizeConversationPolicy } from './participants';
import { currentChannelSelection } from './selection';
import { dashboardBase, escapeMrkdwn, repoLabel, repoOgImage, respondViaUrl } from './util';
import type { SlashCtx, SlashResponse } from './types';

// The Slack rendering of channel settings: the `/kortix` panel, the project,
// agent and model pickers, and the setters behind `/kortix switch|unbind|agent|
// model|policy` and their buttons. What may change, and who may change it,
// lives in core/settings.ts.

export function slackUserOf(ctx: { teamId: string; slackUserId: string }): ChatUser {
  return chatUser('slack', ctx.teamId, ctx.slackUserId);
}

/**
 * The reply for a refused settings change. `noBinding` is the surface's own
 * "bind a project first" text.
 */
export function settingsRefusalText(reason: SettingsRefusal, command: string, noBinding: string): string {
  switch (reason) {
    case 'unlinked':
      return config.SLACK_REQUIRE_USER_IDENTITY
        ? `Connect your Kortix account first: \`${command} login\`. Channel settings change only for a linked project manager.`
        : "Change this channel's settings in Kortix: Slack account linking is off on this server.";
    case 'forbidden':
      return "Only a project manager, or an account owner or admin, can change this channel's settings.";
    case 'no_binding':
      return noBinding;
  }
}

const ephemeral = (text: string): SlashResponse => ({ response_type: 'ephemeral', text });

/** The reply for a model change, shared by `/kortix model` and the model picker buttons. */
export function modelChangeText(
  result: Awaited<ReturnType<typeof changeChannelModel>>,
  requested: string,
  command: string,
): string {
  const id = escapeMrkdwn(requested);
  if (result.ok) {
    if (!result.model) return 'Model reset to the project default.';
    if (result.native) return `Model for this channel set to \`${escapeMrkdwn(result.model)}\`. New sessions will use it.`;
    return `Model for this channel set to *${escapeMrkdwn(labelForModelRef(result.model))}* (\`${escapeMrkdwn(result.model)}\`). New sessions will use it.`;
  }
  switch (result.reason) {
    case 'invalid_id':
      return `\`${id}\` doesn't look like a model id. Use \`provider/model\` (e.g. \`anthropic/claude-sonnet-4.6\`) or a managed id (e.g. \`kortix/deepseek-v4.1-flash\` or \`deepseek-v4.1-flash\`).`;
    case 'not_native':
      return `\`${id}\` isn't usable here — this project runs native OpenCode models (LLM gateway off). Use \`provider/model\`, e.g. \`anthropic/claude-sonnet-4-6\`.`;
    case 'not_servable':
      return `\`${id}\` isn't available for this workspace. Pick one from \`${command} models\`, or connect that provider's API key in Kortix first.`;
    default:
      return settingsRefusalText(result.reason, command, `Connect a project first — run \`${command}\`.`);
  }
}

/** The reply for an agent change, shared by `/kortix agent` and the agent picker buttons. */
export function agentChangeText(
  result: Awaited<ReturnType<typeof changeChannelAgent>>,
  requested: string,
  command: string,
  noBinding: string,
): string {
  if (result.ok) {
    return result.agent
      ? `Agent for this channel set to *${escapeMrkdwn(result.agent)}*. New sessions will use it.`
      : 'Agent reset to the project default.';
  }
  if (result.reason === 'unknown_agent') {
    return `"${escapeMrkdwn(requested)}" is not a declared agent in this project's manifest. Run \`${command} agents\` to pick one.`;
  }
  return settingsRefusalText(result.reason, command, noBinding);
}

// ── Projects ─────────────────────────────────────────────────────────────────

type WorkspaceProject = { projectId: string; name: string; repoUrl: string };

/**
 * `/kortix projects` (`list`) and `/kortix switch` (`switch`): the projects
 * installed in this workspace, with the channel's current one marked. Every
 * card offers "Switch to this"; the switch itself is `switch_project_*`.
 */
async function projectPicker(ctx: SlashCtx, mode: 'list' | 'switch'): Promise<SlashResponse> {
  const rows = await listWorkspaceProjects(ctx.teamId);
  const dashboard = dashboardBase(config.FRONTEND_URL);
  if (rows.length === 0) {
    return {
      response_type: 'ephemeral',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: mode === 'list'
              ? '*No Kortix projects connected yet.*\nHead to your Kortix dashboard to link one to this workspace.'
              : '*No projects to switch to.*\nLink a project to this workspace from your Kortix dashboard first.',
          },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: 'Open dashboard', emoji: true },
            style: 'primary',
            url: dashboard,
            action_id: mode === 'list' ? 'projects_empty_dashboard' : 'switch_empty_dashboard',
          },
        },
      ],
    };
  }
  const current = await currentChannelProjectId(ctx);
  const header = mode === 'list' ? `Connected projects · ${rows.length}` : 'Switch this channel to…';
  const blocks: Array<Record<string, unknown>> = [
    { type: 'header', text: { type: 'plain_text', text: header, emoji: true } },
  ];
  if (rows.length >= 2) {
    blocks.push({ type: 'carousel', elements: rows.map((p) => projectCard(p, p.projectId === current, ctx.channelId, mode)) });
    return { response_type: 'ephemeral', blocks };
  }
  const p = rows[0];
  const isBound = p.projectId === current;
  const repo = `_<${p.repoUrl}|${escapeMrkdwn(repoLabel(p.repoUrl))}>_`;
  if (mode === 'switch') {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `Only one project connected: *${escapeMrkdwn(p.name)}*\n${repo}` } });
    return { response_type: 'ephemeral', blocks };
  }
  const og = repoOgImage(p.repoUrl);
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `${isBound ? '✓ ' : '🟢 '}*${escapeMrkdwn(p.name)}*\n${repo}\n${isBound ? '🟢  Bound to this channel.' : ''}` },
    ...(og ? { accessory: { type: 'image', image_url: og, alt_text: `${p.name} repo` } } : {}),
  });
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Open project', emoji: true },
        style: 'primary',
        url: `${dashboard}/projects/${p.projectId}`,
        action_id: `projects_open_${p.projectId}`,
      },
    ],
  });
  return { response_type: 'ephemeral', blocks };
}

function projectCard(p: WorkspaceProject, isBound: boolean, channelId: string, mode: 'list' | 'switch'): Record<string, unknown> {
  const switchValue = JSON.stringify({ p: p.projectId, c: channelId });
  const title = { type: 'mrkdwn', text: `${isBound ? '✓ ' : ''}*${escapeMrkdwn(p.name)}*` };
  const subtitle = { type: 'mrkdwn', text: `_${escapeMrkdwn(repoLabel(p.repoUrl))}_` };
  if (mode === 'switch') {
    return {
      type: 'card',
      block_id: `switch_${p.projectId}`,
      title,
      subtitle,
      body: { type: 'mrkdwn', text: isBound ? 'Currently bound to this channel.' : 'Pick this to route `@`-mentions here to this project.' },
      actions: [
        {
          type: 'button',
          text: { type: 'plain_text', text: isBound ? '✓ Current' : 'Pick this', emoji: true },
          style: isBound ? undefined : 'primary',
          action_id: `switch_project_${p.projectId}`,
          value: switchValue,
        },
      ],
    };
  }
  return {
    type: 'card',
    block_id: `proj_${p.projectId}`,
    title,
    subtitle,
    body: {
      type: 'mrkdwn',
      text: isBound ? '🟢  Bound to this channel — `@`-mentions here go to this project.' : '🟢  Connected to this workspace.',
    },
    actions: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Open', emoji: true },
        style: 'primary',
        url: `${dashboardBase(config.FRONTEND_URL)}/projects/${p.projectId}`,
        action_id: `projects_open_${p.projectId}`,
      },
      ...(!isBound
        ? [{ type: 'button', text: { type: 'plain_text', text: 'Switch to this', emoji: true }, action_id: `switch_project_${p.projectId}`, value: switchValue }]
        : []),
    ],
  };
}

export const slashProjects = (ctx: SlashCtx) => projectPicker(ctx, 'list');
export const slashSwitch = (ctx: SlashCtx) => projectPicker(ctx, 'switch');

export async function slashUnbind(ctx: SlashCtx): Promise<SlashResponse> {
  if (!ctx.channelId) return ephemeral('No channel context — run this from inside a channel.');
  const result = await unbindChannel(slackUserOf(ctx), ctx);
  if (!result.ok) return ephemeral(settingsRefusalText(result.reason, ctx.command, ''));
  return {
    response_type: 'ephemeral',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Unbound.*\nThe next `@`-mention will show the project picker again.' },
      },
    ],
  };
}

// ── Panel ────────────────────────────────────────────────────────────────────

// A context line stating whether the caller has linked their own Kortix account.
async function buildIdentityContext(ctx: SlashCtx): Promise<Record<string, unknown>> {
  const identity = ctx.slackUserId ? await lookupChatIdentity(slackUserOf(ctx)) : null;
  if (!identity) {
    return {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `🔌  Not connected — run \`${ctx.command} login\` to run as your own Kortix account.` }],
    };
  }
  const email = (await lookupEmailsByUserIds([identity.userId])).get(identity.userId);
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `🔗  Connected as *${email ? escapeMrkdwn(email) : 'your Kortix account'}*` }],
  };
}

// Honest source label for an effective model/agent: how the value was decided,
// so the panel reads "Sonnet 4.6 · project default" instead of implying a pin.
function sourceLabel(source: string): string {
  switch (source) {
    case 'explicit':
      return 'channel override';
    case 'agent':
      return 'agent default';
    case 'project':
      return 'project default';
    case 'account':
      return 'account default';
    default:
      return 'platform default';
  }
}

// The single `/kortix` channel control panel. Consolidates project binding +
// agent + model + join policy + account + sessions into one interactive card,
// each row showing the EFFECTIVE value and where it came from. Inline buttons
// open the focused pickers (real-catalog models, live agents, projects). DB-only
// (no git) so it answers inside Slack's 3s window; the agent picker, opened on
// demand, is the only git-touching path.
export async function slashPanel(ctx: SlashCtx): Promise<SlashResponse> {
  const identityBlocks = config.SLACK_REQUIRE_USER_IDENTITY ? [await buildIdentityContext(ctx)] : [];
  const selection = await currentChannelSelection(ctx);
  const currentId = selection?.projectId ?? null;
  if (!currentId) {
    return {
      response_type: 'ephemeral',
      blocks: [
        ...identityBlocks,
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*No project is connected to this channel yet.*\nConnect one to start working here.`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Connect a project', emoji: true },
              style: 'primary',
              action_id: 'cfg_open_projects',
              value: JSON.stringify({ c: ctx.channelId }),
            },
          ],
        },
      ],
    };
  }
  const [p] = await db
    .select({ projectId: projects.projectId, name: projects.name, repoUrl: projects.repoUrl, metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, currentId))
    .limit(1);
  if (!p) {
    return {
      response_type: 'ephemeral',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*This channel's connected project no longer exists.*\nReconnect one below.` },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Connect a project', emoji: true },
              style: 'primary',
              action_id: 'cfg_open_projects',
              value: JSON.stringify({ c: ctx.channelId }),
            },
          ],
        },
      ],
    };
  }
  const og = repoOgImage(p.repoUrl);

  // Effective AGENT (channel override → project default → 'default').
  const projectDefaultAgent =
    typeof (p.metadata as Record<string, unknown> | null)?.default_agent === 'string'
      ? ((p.metadata as Record<string, unknown>).default_agent as string)
      : null;
  const agent = chooseEffectiveAgent({ explicit: selection?.agentName ?? null, projectDefault: projectDefaultAgent });

  // Effective MODEL (channel override → project/account/platform), with source.
  const gate = await channelModelContext(ctx);
  let modelText = '`not configured` · platform default';
  if (gate && !gate.llmGatewayEnabled) {
    // Native mode: report the channel pin verbatim, or OpenCode's own default.
    modelText = selection?.opencodeModel
      ? `\`${escapeMrkdwn(selection.opencodeModel)}\` · channel`
      : '*OpenCode default* · native';
  } else if (gate) {
    const eff = await resolveEffectiveModel({
      userId: gate.ownerUserId,
      accountId: gate.accountId,
      projectId: gate.projectId,
      agentName: selection?.agentName ?? null,
      explicit: selection?.opencodeModel ?? null,
      freeModelsOnly: gate.freeManagedOnly,
    });
    const label = eff.model ? labelForModelRef(eff.model) : 'No model configured';
    modelText = `*${escapeMrkdwn(label)}* · ${sourceLabel(eff.source)}`;
  }

  const policy = normalizeConversationPolicy(selection?.conversationPolicy);
  const section: Record<string, unknown> = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `🟢  *${escapeMrkdwn(p.name)}*  ·  connected to this channel\n_<${p.repoUrl}|${escapeMrkdwn(repoLabel(p.repoUrl))}>_`,
    },
  };
  if (og) section.accessory = { type: 'image', image_url: og, alt_text: `${p.name} repo` };
  return {
    response_type: 'ephemeral',
    blocks: [
      ...identityBlocks,
      section,
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `🤖  Agent: *${escapeMrkdwn(agent.agent)}* · ${sourceLabel(agent.source)}` },
          { type: 'mrkdwn', text: `🧠  Model: ${modelText}` },
          { type: 'mrkdwn', text: `🔒  Slack sessions: *${conversationPolicyLabel(policy)}*` },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Change model', emoji: true },
            action_id: 'cfg_open_models',
            value: JSON.stringify({ c: ctx.channelId }),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Change agent', emoji: true },
            action_id: 'cfg_open_agents',
            value: JSON.stringify({ c: ctx.channelId }),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Change project', emoji: true },
            action_id: 'cfg_open_projects',
            value: JSON.stringify({ c: ctx.channelId }),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open in Kortix ↗', emoji: true },
            style: 'primary',
            url: `${dashboardBase(config.FRONTEND_URL)}/projects/${p.projectId}`,
            action_id: `panel_open_${p.projectId}`,
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Advanced: \`${ctx.command} model <id>\` · \`${ctx.command} policy\` · \`${ctx.command} sessions\` · \`${ctx.command} help\``,
          },
        ],
      },
    ],
  };
}

// ── Policy ───────────────────────────────────────────────────────────────────

export async function slashPolicy(ctx: SlashCtx, arg: string): Promise<SlashResponse> {
  const selection = await currentChannelSelection(ctx);
  if (!selection) {
    return {
      response_type: 'ephemeral',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*No project bound to this channel.*\nRun \`${ctx.command} switch\` first.` } }],
    };
  }

  const requested = arg.trim();
  const current = normalizeConversationPolicy(selection.conversationPolicy);
  if (!requested) {
    return {
      response_type: 'ephemeral',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Slack session policy: ${conversationPolicyLabel(current)}*\nNew Slack sessions in this channel use this policy.`,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Default is \`project_open\`: linked project members can join Slack-started sessions. Use \`owner_approval\` for private threads with owner approval, or \`owner_only\` to block everyone else.`,
            },
          ],
        },
      ],
    };
  }

  const next = normalizeConversationPolicy(requested);
  if (next !== requested) {
    return ephemeral(`Unknown policy \`${requested}\`. Use \`owner_approval\`, \`owner_only\`, or \`project_open\`.`);
  }
  const result = await changeChannelPolicy(slackUserOf(ctx), ctx, next);
  if (!result.ok) {
    return ephemeral(settingsRefusalText(result.reason, ctx.command, 'That channel is no longer bound to a project.'));
  }
  return ephemeral(
    `Slack session policy set to ${conversationPolicyLabel(next)} for this channel. Existing threads keep their original policy.`,
  );
}

// ── Agents ───────────────────────────────────────────────────────────────────

export async function slashAgents(ctx: SlashCtx, arg: string): Promise<SlashResponse> {
  // `/kortix agents <name>` is a convenient alias for setting the agent.
  if (arg.trim()) return slashSetAgent(ctx, arg);

  const selection = await currentChannelSelection(ctx);
  if (!selection) {
    return {
      response_type: 'ephemeral',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*No project bound to this channel.*\nRun \`${ctx.command} switch\` first, then pick an agent.` } }],
    };
  }
  // Listing agents touches git — too slow for the synchronous 3s window. Ack
  // immediately and post the real picker out-of-band: to the response_url for a
  // real slash command, or straight into the DM for the message-fallback path.
  void (async () => {
    const agents = await loadScopedChannelAgents({
      teamId: ctx.teamId,
      projectId: selection.projectId,
      slackUserId: ctx.slackUserId,
    });
    const blocks = buildAgentPickerBlocks(ctx.channelId, selection.agentName, agents);
    if (ctx.deferredDeliver) {
      await ctx.deferredDeliver({ response_type: 'ephemeral', blocks });
    } else {
      await respondViaUrl(ctx.responseUrl, { response_type: 'ephemeral', replace_original: true, blocks });
    }
  })();
  return ephemeral('Loading agents…');
}

export async function slashSetAgent(ctx: SlashCtx, arg: string): Promise<SlashResponse> {
  const name = arg.trim();
  if (!name) {
    return ephemeral(`Usage: \`${ctx.command} agent <name>\` (or \`${ctx.command} agents\` to pick).`);
  }
  const result = await changeChannelAgent(slackUserOf(ctx), ctx, name);
  return ephemeral(agentChangeText(result, name, ctx.command, `Bind a project first with \`${ctx.command} switch\`.`));
}

// ── Models ───────────────────────────────────────────────────────────────────

export async function slashModels(ctx: SlashCtx): Promise<SlashResponse> {
  const gate = await channelModelContext(ctx);
  if (!gate) {
    return {
      response_type: 'ephemeral',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*No project is connected to this channel yet.*\nRun \`${ctx.command}\` to connect one, then pick a model.` } }],
    };
  }
  const selection = await currentChannelSelection(ctx);
  const current = selection?.opencodeModel ?? null;
  // Native mode: the gateway picker catalog does not exist for this project.
  // The channel model is a native `provider/model` ref set directly.
  if (!gate.llmGatewayEnabled) {
    return {
      response_type: 'ephemeral',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: 'Models', emoji: true } },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: current
              ? `This channel uses \`${escapeMrkdwn(current)}\`.`
              : 'This channel uses the *project default* (resolved by OpenCode in the sandbox).',
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `This project runs native OpenCode models (LLM gateway off). Set any connected provider's model with \`${ctx.command} model provider/model\` (e.g. \`anthropic/claude-sonnet-4-6\`), or \`${ctx.command} model default\` to reset.`,
            },
          ],
        },
      ],
    };
  }
  const isCurrent = (id: string) => !!current && toWireModel(current) === toWireModel(id);

  // The REAL served catalog — managed models + the project's connected BYOK
  // providers — plus the resolved project default. No hardcoded list, so a pick
  // can never 404.
  const { models, projectDefault } = await listPickerModels({
    projectId: gate.projectId,
    userId: gate.ownerUserId,
    accountId: gate.accountId,
    freeManagedOnly: gate.freeManagedOnly,
    agentName: selection?.agentName ?? null,
  });

  const blocks: Array<Record<string, unknown>> = [
    { type: 'header', text: { type: 'plain_text', text: 'Models', emoji: true } },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: current
            ? `This channel uses *${escapeMrkdwn(labelForModelRef(current))}*.`
            : `This channel uses the *project default*${projectDefault.label ? ` (${escapeMrkdwn(projectDefault.label)})` : ''}.`,
        },
      ],
    },
  ];

  // "Project default" clears the per-channel override.
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `${current ? '' : '✓ '}*Use project default*${projectDefault.label ? `  ·  _${escapeMrkdwn(projectDefault.label)}_` : ''}`,
    },
    accessory: {
      type: 'button',
      text: { type: 'plain_text', text: current ? 'Reset' : '✓ Current', emoji: true },
      style: current ? 'primary' : undefined,
      action_id: 'set_model_default',
      value: JSON.stringify({ c: ctx.channelId, m: '' }),
    },
  });

  for (const m of models) {
    const cur = isCurrent(m.id);
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${cur ? '✓ ' : ''}*${escapeMrkdwn(m.label)}*${m.hint ? `  ·  _${escapeMrkdwn(m.hint)}_` : ''}\n\`${escapeMrkdwn(m.id)}\`` },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: cur ? '✓ Current' : 'Use this', emoji: true },
        style: cur ? undefined : 'primary',
        action_id: `set_model_${m.id}`.slice(0, 250),
        value: JSON.stringify({ c: ctx.channelId, m: m.id }),
      },
    });
  }
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Any model works: \`${ctx.command} model provider/model-id\` (must be a managed model or a provider you've connected).` }],
  });
  return { response_type: 'ephemeral', blocks };
}

export async function slashSetModel(ctx: SlashCtx, arg: string): Promise<SlashResponse> {
  const id = arg.trim();
  if (!id) return slashModels(ctx);
  return ephemeral(modelChangeText(await changeChannelModel(slackUserOf(ctx), ctx, id), id, ctx.command));
}

export async function listWorkspaceProjects(teamId: string): Promise<WorkspaceProject[]> {
  const installs = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'slack'), eq(chatInstalls.workspaceId, teamId)));
  if (installs.length === 0) return [];
  const ids = installs.map((i) => i.projectId);
  return db
    .select({ projectId: projects.projectId, name: projects.name, repoUrl: projects.repoUrl })
    .from(projects)
    .where(inArray(projects.projectId, ids));
}

export async function currentChannelProjectId(ctx: { teamId: string; channelId: string }): Promise<string | null> {
  if (!ctx.channelId) return null;
  const [binding] = await db
    .select({ projectId: chatChannelBindings.projectId })
    .from(chatChannelBindings)
    .where(and(
      eq(chatChannelBindings.platform, 'slack'),
      eq(chatChannelBindings.workspaceId, ctx.teamId),
      eq(chatChannelBindings.channelId, ctx.channelId),
    ))
    .limit(1);
  return binding?.projectId ?? null;
}
