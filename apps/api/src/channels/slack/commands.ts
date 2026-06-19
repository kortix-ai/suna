import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { chatChannelBindings, chatInstalls, chatThreads, projectSessions, projects } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import { escapeMrkdwn, formatRelativeTime, repoLabel, repoOgImage, respondViaUrl, sessionWebUrl } from './util';
import {
  RECOMMENDED_MODELS,
  currentChannelSelection,
  isValidModelId,
  listProjectAgents,
  modelLabel,
  setChannelAgent,
  setChannelModel,
} from './selection';
import type { SlashResponse } from './types';

export interface SlashCtx {
  teamId: string;
  channelId: string;
  command: string;
  // Slack slash response_url — valid ~30 min / 5 uses. Used to post a deferred
  // reply for subcommands too slow for the synchronous 3s window (agent list
  // touches git). DB-only subcommands answer synchronously and ignore it.
  responseUrl?: string;
  // DM fallback path: the Assistant pane delivers `/kortix …` as a plain message
  // (no response_url), so deferred subcommands post their result through this
  // instead of `respondViaUrl`. Set only by the DM command runner.
  deferredDeliver?: (resp: SlashResponse) => Promise<void>;
}

export async function handleSlashCommand(
  sub: string,
  arg: string,
  ctx: SlashCtx,
): Promise<SlashResponse> {
  switch (sub) {
    case 'projects':
    case 'list':
      return slashProjects(ctx);
    case 'switch':
    case 'use':
    case 'rebind':
      return slashSwitch(ctx);
    case 'unbind':
      return slashUnbind(ctx);
    case 'sessions':
      return slashSessions(ctx);
    case 'session':
      return slashSession(ctx);
    case 'whoami':
    case 'who':
      return slashWhoami(ctx);
    case 'agents':
      return slashAgents(ctx, arg);
    case 'agent':
    case 'use-agent':
    case 'set-agent':
      return slashSetAgent(ctx, arg);
    case 'models':
      return slashModels(ctx);
    case 'model':
    case 'use-model':
    case 'set-model':
      return slashSetModel(ctx, arg);
    case 'help':
    case '':
      return slashHelp(ctx.command);
    default:
      return {
        response_type: 'ephemeral',
        text: `Unknown subcommand \`${sub}\`. Try \`${ctx.command} help\`.`,
      };
  }
}

function slashHelp(command: string): SlashResponse {
  return {
    response_type: 'ephemeral',
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '⚡  Kortix slash commands', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Drive Kortix from any Slack channel. All responses are private to you.',
        },
      },
      { type: 'divider' },
      ...[
        { cmd: `${command} projects`, desc: 'List every Kortix project connected to this workspace.' },
        { cmd: `${command} switch`,   desc: 'Bind this channel to a different project (opens a picker).' },
        { cmd: `${command} unbind`,   desc: 'Clear this channel\'s project binding.' },
        { cmd: `${command} agents`,   desc: 'List this project\'s agents and pick which one answers here.' },
        { cmd: `${command} agent <name>`, desc: 'Set the agent for this channel (`default` to reset).' },
        { cmd: `${command} models`,   desc: 'List models and pick which one this channel uses.' },
        { cmd: `${command} model <id>`, desc: 'Set the model, e.g. `anthropic/claude-opus-4-8` (`default` to reset).' },
        { cmd: `${command} session`,  desc: 'Show this channel\'s most recent session + open it on the web.' },
        { cmd: `${command} sessions`, desc: 'Show the last 5 sessions started in this workspace.' },
        { cmd: `${command} whoami`,   desc: 'What project, agent, and model are set for this channel.' },
        { cmd: `${command} help`,     desc: 'This message.' },
      ].map((r) => ({
        type: 'section',
        text: { type: 'mrkdwn', text: `\`${r.cmd}\`\n${r.desc}` },
      })),
    ],
  };
}

async function slashProjects(ctx: { teamId: string; channelId: string }): Promise<SlashResponse> {
  const rows = await listWorkspaceProjects(ctx.teamId);
  if (rows.length === 0) {
    return {
      response_type: 'ephemeral',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*No Kortix projects connected yet.*\nHead to your Kortix dashboard to link one to this workspace.',
          },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: 'Open dashboard', emoji: true },
            style: 'primary',
            url: (config.FRONTEND_URL || 'https://kortix.com').replace(/\/$/, ''),
            action_id: 'projects_empty_dashboard',
          },
        },
      ],
    };
  }
  const current = await currentChannelProjectId(ctx);
  const dashboardBase = (config.FRONTEND_URL || 'https://kortix.com').replace(/\/$/, '');
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Connected projects · ${rows.length}`, emoji: true },
    },
  ];
  if (rows.length >= 2) {
    blocks.push({
      type: 'carousel',
      elements: rows.map((p) => {
        const isBound = p.projectId === current;
        const og = repoOgImage(p.repoUrl);
        const card: Record<string, unknown> = {
          type: 'card',
          block_id: `proj_${p.projectId}`,
          title: { type: 'mrkdwn', text: `${isBound ? '✓ ' : ''}*${escapeMrkdwn(p.name)}*` },
          subtitle: { type: 'mrkdwn', text: `_${escapeMrkdwn(repoLabel(p.repoUrl))}_` },
          body: {
            type: 'mrkdwn',
            text: isBound ? '🟢  Bound to this channel — `@`-mentions here go to this project.' : '🟢  Connected to this workspace.',
          },
          actions: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Open', emoji: true },
              style: 'primary',
              url: `${dashboardBase}/projects/${p.projectId}`,
              action_id: `projects_open_${p.projectId}`,
            },
            ...(!isBound ? [{
              type: 'button',
              text: { type: 'plain_text', text: 'Switch to this', emoji: true },
              action_id: `switch_project_${p.projectId}`,
              value: JSON.stringify({ p: p.projectId, c: ctx.channelId }),
            }] : []),
          ],
        };
        void og;
        return card;
      }),
    });
  } else {
    const p = rows[0];
    const isBound = p.projectId === current;
    const og = repoOgImage(p.repoUrl);
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${isBound ? '✓ ' : '🟢 '}*${escapeMrkdwn(p.name)}*\n_<${p.repoUrl}|${escapeMrkdwn(repoLabel(p.repoUrl))}>_\n${isBound ? '🟢  Bound to this channel.' : ''}`,
      },
      ...(og ? { accessory: { type: 'image', image_url: og, alt_text: `${p.name} repo` } } : {}),
    });
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open project', emoji: true },
          style: 'primary',
          url: `${dashboardBase}/projects/${p.projectId}`,
          action_id: `projects_open_${p.projectId}`,
        },
      ],
    });
  }
  return { response_type: 'ephemeral', blocks };
}

async function slashSwitch(ctx: { teamId: string; channelId: string }): Promise<SlashResponse> {
  const rows = await listWorkspaceProjects(ctx.teamId);
  if (rows.length === 0) {
    return {
      response_type: 'ephemeral',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*No projects to switch to.*\nLink a project to this workspace from your Kortix dashboard first.' },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: 'Open dashboard', emoji: true },
            style: 'primary',
            url: (config.FRONTEND_URL || 'https://kortix.com').replace(/\/$/, ''),
            action_id: 'switch_empty_dashboard',
          },
        },
      ],
    };
  }
  const current = await currentChannelProjectId(ctx);
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Switch this channel to…', emoji: true },
    },
  ];
  if (rows.length >= 2) {
    blocks.push({
      type: 'carousel',
      elements: rows.map((p) => {
        const isBound = p.projectId === current;
        const og = repoOgImage(p.repoUrl);
        const card: Record<string, unknown> = {
          type: 'card',
          block_id: `switch_${p.projectId}`,
          title: { type: 'mrkdwn', text: `${isBound ? '✓ ' : ''}*${escapeMrkdwn(p.name)}*` },
          subtitle: { type: 'mrkdwn', text: `_${escapeMrkdwn(repoLabel(p.repoUrl))}_` },
          body: {
            type: 'mrkdwn',
            text: isBound ? 'Currently bound to this channel.' : 'Pick this to route `@`-mentions here to this project.',
          },
          actions: [
            {
              type: 'button',
              text: { type: 'plain_text', text: isBound ? '✓ Current' : 'Pick this', emoji: true },
              style: isBound ? undefined : 'primary',
              action_id: `switch_project_${p.projectId}`,
              value: JSON.stringify({ p: p.projectId, c: ctx.channelId }),
            },
          ],
        };
        void og;
        return card;
      }),
    });
  } else {
    const p = rows[0];
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Only one project connected: *${escapeMrkdwn(p.name)}*\n_<${p.repoUrl}|${escapeMrkdwn(repoLabel(p.repoUrl))}>_`,
      },
    });
  }
  return { response_type: 'ephemeral', blocks };
}

async function slashUnbind(ctx: { teamId: string; channelId: string }): Promise<SlashResponse> {
  if (!ctx.channelId) {
    return { response_type: 'ephemeral', text: 'No channel context — run this from inside a channel.' };
  }
  await db
    .delete(chatChannelBindings)
    .where(and(
      eq(chatChannelBindings.platform, 'slack'),
      eq(chatChannelBindings.workspaceId, ctx.teamId),
      eq(chatChannelBindings.channelId, ctx.channelId),
    ));
  return {
    response_type: 'ephemeral',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Unbound.*\nThe next `@`-mention will show the project picker again.',
        },
      },
    ],
  };
}

async function slashSessions(ctx: { teamId: string; channelId: string }): Promise<SlashResponse> {
  const rows = await db
    .select({
      projectId: chatThreads.projectId,
      sessionId: chatThreads.sessionId,
      lastMessageAt: chatThreads.lastMessageAt,
    })
    .from(chatThreads)
    .where(and(eq(chatThreads.platform, 'slack'), eq(chatThreads.workspaceId, ctx.teamId)))
    .orderBy(desc(chatThreads.lastMessageAt))
    .limit(5);
  if (rows.length === 0) {
    return {
      response_type: 'ephemeral',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: '*No recent Kortix sessions in this workspace.*\n`@`-mention me in any channel to start one.' } },
      ],
    };
  }
  const projectIds = Array.from(new Set(rows.map((r) => r.projectId)));
  const projectRows = await db
    .select({ projectId: projects.projectId, name: projects.name, repoUrl: projects.repoUrl })
    .from(projects)
    .where(inArray(projects.projectId, projectIds));
  const projectById = new Map(projectRows.map((p) => [p.projectId, p]));
  const dashboardBase = (config.FRONTEND_URL || 'https://kortix.com').replace(/\/$/, '');
  return {
    response_type: 'ephemeral',
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Recent sessions', emoji: true },
      },
      ...rows.flatMap((r) => {
        const p = projectById.get(r.projectId);
        const projectName = p?.name ?? 'project';
        const og = p ? repoOgImage(p.repoUrl) : null;
        const section: Record<string, unknown> = {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${escapeMrkdwn(projectName)}*  ·  ${formatRelativeTime(r.lastMessageAt)}\n_<${dashboardBase}/projects/${r.projectId}/sessions/${r.sessionId}|Open session>_`,
          },
          ...(og ? { accessory: { type: 'image', image_url: og, alt_text: `${projectName} repo` } } : {}),
        };
        return [section];
      }),
    ],
  };
}

async function slashWhoami(ctx: SlashCtx): Promise<SlashResponse> {
  const selection = await currentChannelSelection(ctx);
  const currentId = selection?.projectId ?? null;
  const dashboardBase = (config.FRONTEND_URL || 'https://kortix.com').replace(/\/$/, '');
  if (!currentId) {
    return {
      response_type: 'ephemeral',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*No project bound to this channel.*\nRun \`${ctx.command} switch\` to pick one.`,
          },
        },
      ],
    };
  }
  const [p] = await db
    .select({ projectId: projects.projectId, name: projects.name, repoUrl: projects.repoUrl })
    .from(projects)
    .where(eq(projects.projectId, currentId))
    .limit(1);
  if (!p) {
    return {
      response_type: 'ephemeral',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*This channel's bound project no longer exists.*\nRun \`${ctx.command} switch\` to rebind.` },
        },
      ],
    };
  }
  const og = repoOgImage(p.repoUrl);
  const agentLabel = selection?.agentName ?? 'default';
  const modelLabelText = selection?.opencodeModel ? modelLabel(selection.opencodeModel) : 'project default';
  const section: Record<string, unknown> = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `🟢  *${escapeMrkdwn(p.name)}*  ·  ✓ bound to this channel\n_<${p.repoUrl}|${escapeMrkdwn(repoLabel(p.repoUrl))}>_`,
    },
  };
  if (og) section.accessory = { type: 'image', image_url: og, alt_text: `${p.name} repo` };
  return {
    response_type: 'ephemeral',
    blocks: [
      section,
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `🤖  Agent: *${escapeMrkdwn(agentLabel)}*` },
          { type: 'mrkdwn', text: `🧠  Model: *${escapeMrkdwn(modelLabelText)}*` },
          { type: 'mrkdwn', text: `Change with \`${ctx.command} agents\` · \`${ctx.command} models\`` },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open project', emoji: true },
            style: 'primary',
            url: `${dashboardBase}/projects/${p.projectId}`,
            action_id: `whoami_open_${p.projectId}`,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View on GitHub', emoji: true },
            url: p.repoUrl,
            action_id: `whoami_repo_${p.projectId}`,
          },
        ],
      },
    ],
  };
}

// ── Session (singular) ───────────────────────────────────────────────────────
// The most recent session started FROM THIS CHANNEL (sessions stamp the Slack
// channel into metadata.slack.channel), with a button to open it on the web.
const SESSION_STATUS_EMOJI: Record<string, string> = {
  queued: '🟡',
  branching: '🟡',
  provisioning: '🟡',
  running: '🟢',
  completed: '✅',
  stopped: '⚪',
  failed: '🔴',
};

async function slashSession(ctx: SlashCtx): Promise<SlashResponse> {
  const selection = await currentChannelSelection(ctx);
  if (!selection) {
    return {
      response_type: 'ephemeral',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*No project bound to this channel.*\nRun \`${ctx.command} switch\` to pick one, then \`@\`-mention me to start a session.` } }],
    };
  }
  const [s] = await db
    .select({
      sessionId: projectSessions.sessionId,
      status: projectSessions.status,
      agentName: projectSessions.agentName,
      createdAt: projectSessions.createdAt,
    })
    .from(projectSessions)
    .where(and(
      eq(projectSessions.projectId, selection.projectId),
      sql`${projectSessions.metadata}->'slack'->>'channel' = ${ctx.channelId}`,
    ))
    .orderBy(desc(projectSessions.createdAt))
    .limit(1);
  if (!s) {
    return {
      response_type: 'ephemeral',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*No sessions started in this channel yet.*\n\`@\`-mention me to start one.` } }],
    };
  }
  const url = sessionWebUrl(config.FRONTEND_URL, selection.projectId, s.sessionId);
  const emoji = SESSION_STATUS_EMOJI[s.status] ?? '•';
  return {
    response_type: 'ephemeral',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji}  *Latest session in this channel*  ·  ${formatRelativeTime(s.createdAt)}\nStatus: \`${s.status}\`  ·  Agent: \`${escapeMrkdwn(s.agentName)}\``,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open session ↗', emoji: true },
            style: 'primary',
            url,
            action_id: 'session_open',
          },
        ],
      },
    ],
  };
}

// ── Agents ───────────────────────────────────────────────────────────────────

async function slashAgents(ctx: SlashCtx, arg: string): Promise<SlashResponse> {
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
    let agents: Awaited<ReturnType<typeof listProjectAgents>> = [];
    try {
      agents = await listProjectAgents(selection.projectId);
    } catch (err) {
      console.warn('[slack-webhook] listProjectAgents failed', err);
    }
    const blocks = buildAgentPickerBlocks(ctx, selection.agentName, agents);
    if (ctx.deferredDeliver) {
      await ctx.deferredDeliver({ response_type: 'ephemeral', blocks });
    } else {
      await respondViaUrl(ctx.responseUrl, { response_type: 'ephemeral', replace_original: true, blocks });
    }
  })();
  return { response_type: 'ephemeral', text: 'Loading agents…' };
}

function buildAgentPickerBlocks(
  ctx: SlashCtx,
  currentAgent: string | null,
  agents: Array<{ name: string; description: string | null }>,
): Array<Record<string, unknown>> {
  // `default` is the always-available implicit agent. Listed first.
  const rows: Array<{ name: string; description: string | null }> = [
    { name: 'default', description: 'The project\'s default agent.' },
    ...agents.filter((a) => a.name !== 'default'),
  ];
  const current = currentAgent ?? 'default';
  const blocks: Array<Record<string, unknown>> = [
    { type: 'header', text: { type: 'plain_text', text: 'Agents', emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Pick which agent answers in this channel. Current: *${escapeMrkdwn(current)}*` }] },
  ];
  for (const a of rows) {
    const isCurrent = a.name === current;
    const value = JSON.stringify({ c: ctx.channelId, a: a.name === 'default' ? '' : a.name });
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

async function slashSetAgent(ctx: SlashCtx, arg: string): Promise<SlashResponse> {
  const name = arg.trim();
  if (!name) {
    return { response_type: 'ephemeral', text: `Usage: \`${ctx.command} agent <name>\` (or \`${ctx.command} agents\` to pick).` };
  }
  const selection = await currentChannelSelection(ctx);
  if (!selection) {
    return { response_type: 'ephemeral', text: `Bind a project first with \`${ctx.command} switch\`.` };
  }
  const value = name.toLowerCase() === 'default' ? null : name;
  const ok = await setChannelAgent(ctx, value);
  if (!ok) {
    return { response_type: 'ephemeral', text: `Bind a project first with \`${ctx.command} switch\`.` };
  }
  return {
    response_type: 'ephemeral',
    text: value ? `Agent for this channel set to *${escapeMrkdwn(value)}*. New sessions will use it.` : 'Agent reset to the project default.',
  };
}

// ── Models ───────────────────────────────────────────────────────────────────

async function slashModels(ctx: SlashCtx): Promise<SlashResponse> {
  const selection = await currentChannelSelection(ctx);
  if (!selection) {
    return {
      response_type: 'ephemeral',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*No project bound to this channel.*\nRun \`${ctx.command} switch\` first, then pick a model.` } }],
    };
  }
  const current = selection.opencodeModel;
  const blocks: Array<Record<string, unknown>> = [
    { type: 'header', text: { type: 'plain_text', text: 'Models', emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Pick a model for this channel. Current: *${current ? escapeMrkdwn(modelLabel(current)) : 'project default'}*` }] },
  ];
  // "Project default" clears the override.
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `${current ? '' : '✓ '}*Project default*\n_Whatever the repo's opencode config sets._` },
    accessory: {
      type: 'button',
      text: { type: 'plain_text', text: current ? 'Reset' : '✓ Current', emoji: true },
      style: current ? 'primary' : undefined,
      action_id: 'set_model_default',
      value: JSON.stringify({ c: ctx.channelId, m: '' }),
    },
  });
  for (const m of RECOMMENDED_MODELS) {
    const isCurrent = current === m.id;
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${isCurrent ? '✓ ' : ''}*${escapeMrkdwn(m.label)}*  ·  _${escapeMrkdwn(m.hint)}_\n\`${escapeMrkdwn(m.id)}\`` },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: isCurrent ? '✓ Current' : 'Use this', emoji: true },
        style: isCurrent ? undefined : 'primary',
        action_id: `set_model_${m.id}`.slice(0, 250),
        value: JSON.stringify({ c: ctx.channelId, m: m.id }),
      },
    });
  }
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Any model works: \`${ctx.command} model provider/model-id\` (availability depends on your project's connected providers).` }],
  });
  return { response_type: 'ephemeral', blocks };
}

async function slashSetModel(ctx: SlashCtx, arg: string): Promise<SlashResponse> {
  const id = arg.trim();
  if (!id) return slashModels(ctx);
  const selection = await currentChannelSelection(ctx);
  if (!selection) {
    return { response_type: 'ephemeral', text: `Bind a project first with \`${ctx.command} switch\`.` };
  }
  if (id.toLowerCase() === 'default') {
    const ok = await setChannelModel(ctx, null);
    if (!ok) return { response_type: 'ephemeral', text: `Bind a project first with \`${ctx.command} switch\`.` };
    return { response_type: 'ephemeral', text: 'Model reset to the project default.' };
  }
  if (!isValidModelId(id)) {
    return { response_type: 'ephemeral', text: `\`${escapeMrkdwn(id)}\` doesn't look like a model id. Use \`provider/model\`, e.g. \`anthropic/claude-opus-4-8\`.` };
  }
  const ok = await setChannelModel(ctx, id);
  if (!ok) return { response_type: 'ephemeral', text: `Bind a project first with \`${ctx.command} switch\`.` };
  return { response_type: 'ephemeral', text: `Model for this channel set to *${escapeMrkdwn(modelLabel(id))}* (\`${escapeMrkdwn(id)}\`). New sessions will use it.` };
}

export async function listWorkspaceProjects(teamId: string): Promise<Array<{ projectId: string; name: string; repoUrl: string }>> {
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
