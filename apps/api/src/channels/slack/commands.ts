import { and, desc, eq, sql } from 'drizzle-orm';
import { projectSessions, projects } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import { escapeMrkdwn, formatRelativeTime, repoOgImage, sessionWebUrl } from './util';
import { currentChannelSelection } from './selection';
import { buildSlackLoginUrl } from './login';
import { findBotUserIdByName, isBotUser } from '../slack-api';
import { loadSlackTokenForProject } from '../install-store';
import {
  chatUser,
  linkChatIdentity,
  lookupChatIdentity,
  resolveProjectChatActor,
  revokeChatIdentity,
} from '../core/identity';
import { listVisibleChatSessions } from '../core/sessions';
import {
  slackUserOf,
  slashAgents,
  slashModels,
  slashPanel,
  slashPolicy,
  slashProjects,
  slashSetAgent,
  slashSetModel,
  slashSwitch,
  slashUnbind,
} from './settings-commands';
import type { SlashCtx, SlashResponse } from './types';

// `/kortix` subcommands. Channel settings (panel, projects, agent, model,
// policy) render in settings-commands.ts; this file routes every subcommand and
// owns the account, bot-link, and session ones.

export async function handleSlashCommand(
  sub: string,
  arg: string,
  ctx: SlashCtx,
): Promise<SlashResponse> {
  switch (sub) {
    case 'projects':
    case 'list':
      if (ctx.projectScopedProjectId) return slashProjectScopedInfo(ctx);
      return slashProjects(ctx);
    case 'switch':
    case 'use':
    case 'rebind':
      if (ctx.projectScopedProjectId) return slashProjectScopedInfo(ctx);
      return slashSwitch(ctx);
    case 'unbind':
      if (ctx.projectScopedProjectId) return slashProjectScopedInfo(ctx);
      return slashUnbind(ctx);
    case 'sessions':
      return slashSessions(ctx);
    case 'session':
      return slashSession(ctx);
    case 'login':
    case 'connect':
      // Whole feature is flag-gated: when off, `/login` doesn't exist.
      return config.SLACK_REQUIRE_USER_IDENTITY ? slashLogin(ctx) : unknownSub(sub, ctx.command);
    case 'logout':
    case 'disconnect':
      return config.SLACK_REQUIRE_USER_IDENTITY ? slashLogout(ctx) : unknownSub(sub, ctx.command);
    case '':
    case 'config':
    case 'channel':
    case 'settings':
    case 'whoami':
    case 'who':
      return slashPanel(ctx);
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
    case 'policy':
    case 'conversation':
      return slashPolicy(ctx, arg);
    case 'link-bot':
      return config.SLACK_REQUIRE_USER_IDENTITY ? slashLinkBot(ctx, arg) : unknownSub(sub, ctx.command);
    case 'help':
      return slashHelp(ctx);
    default:
      return unknownSub(sub, ctx.command);
  }
}

function unknownSub(sub: string, command: string): SlashResponse {
  return {
    response_type: 'ephemeral',
    text: `Unknown subcommand \`${sub}\`. Try \`${command} help\`.`,
  };
}

function slashHelp(ctx: SlashCtx): SlashResponse {
  const command = ctx.command;
  const isProjectScoped = !!ctx.projectScopedProjectId;
  // Everything lives behind the one `/kortix` panel; the rest are power-user
  // shortcuts for people who'd rather type than click.
  const advanced: Array<{ cmd: string; desc: string }> = [
    { cmd: `${command} model <id>`, desc: 'Set the channel model directly, e.g. `kortix/deepseek-v4.1-flash` or `anthropic/claude-sonnet-4.6` (`default` to reset).' },
    { cmd: `${command} agent <name>`, desc: 'Set the channel agent directly (`default` to reset).' },
    ...(isProjectScoped ? [] : [{ cmd: `${command} switch`, desc: 'Connect this channel to a different project.' }]),
    { cmd: `${command} policy`,   desc: 'Show or change who can join Slack-started sessions here.' },
    { cmd: `${command} sessions`, desc: 'Recent sessions started in this workspace.' },
    ...(config.SLACK_REQUIRE_USER_IDENTITY
      ? [
          { cmd: `${command} login`,  desc: 'Connect your own Kortix account so the agent runs as you.' },
          { cmd: `${command} logout`, desc: 'Disconnect your Kortix account.' },
        ]
      : []),
  ];
  return {
    response_type: 'ephemeral',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '⚡  Kortix', emoji: true } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Run \`${command}\` to open this channel's control panel — connected project, agent, and model, with buttons to change any of them. @-mention me in a thread to put me to work. All responses are private to you.`,
        },
      },
      { type: 'divider' },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '*Shortcuts*' }] },
      ...advanced.map((r) => ({
        type: 'section',
        text: { type: 'mrkdwn', text: `\`${r.cmd}\`\n${r.desc}` },
      })),
    ],
  };
}

async function slashProjectScopedInfo(ctx: SlashCtx): Promise<SlashResponse> {
  const projectId = ctx.projectScopedProjectId;
  const [project] = projectId
    ? await db
        .select({ name: projects.name, projectId: projects.projectId })
        .from(projects)
        .where(eq(projects.projectId, projectId))
        .limit(1)
    : [];
  return {
    response_type: 'ephemeral',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: project
            ? `This Slack app is already tied to *${escapeMrkdwn(project.name)}*.\nUse \`${ctx.command} agents\`, \`${ctx.command} models\`, or \`${ctx.command} policy\` to configure this channel.`
            : `This Slack app is already tied to one Kortix project.\nUse \`${ctx.command} agents\`, \`${ctx.command} models\`, or \`${ctx.command} policy\` to configure this channel.`,
        },
      },
    ],
  };
}

async function slashSessions(ctx: SlashCtx): Promise<SlashResponse> {
  // Only sessions the caller's linked Kortix account may open are listed, and a
  // per-project app lists only its own project's.
  const rows = await listVisibleChatSessions(slackUserOf(ctx), {
    limit: 5,
    projectId: ctx.projectScopedProjectId,
  });
  if (rows === null) {
    return {
      response_type: 'ephemeral',
      text: config.SLACK_REQUIRE_USER_IDENTITY
        ? `Connect your Kortix account to see your recent sessions: \`${ctx.command} login\`.`
        : 'Open Kortix to see recent sessions.',
    };
  }
  if (rows.length === 0) {
    return {
      response_type: 'ephemeral',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: '*No recent Kortix sessions in this workspace.*\n`@`-mention me in any channel to start one.' } },
      ],
    };
  }
  return {
    response_type: 'ephemeral',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Recent sessions', emoji: true } },
      ...rows.map((r) => {
        const og = repoOgImage(r.repoUrl);
        return {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${escapeMrkdwn(r.projectName)}*  ·  ${formatRelativeTime(r.lastMessageAt)}\n_<${sessionWebUrl(config.FRONTEND_URL, r.projectId, r.sessionId)}|Open session>_`,
          },
          ...(og ? { accessory: { type: 'image', image_url: og, alt_text: `${r.projectName} repo` } } : {}),
        };
      }),
    ],
  };
}

// ── Link a bot sender ────────────────────────────────────────────────────────
// A bot has no Kortix account and can never run `/login`, so resolveChatActor
// answers `unlinked` for every message it sends and dispatch stops before the
// turn. That is why an @-mention from another app looked like it did nothing at
// all: the "connect your account" nudge is posted ephemerally AND DM'd to the
// sender — a bot — where no human ever sees it.
//
// This binds a bot's Slack user id to the CALLER's Kortix account through the
// same chat_user_identities row `/login` writes, so the existing authorization
// applies unchanged: the linked user must still be a member of the project's
// account and pass PROJECT_WRITE inside resolveChatActor. Nothing is granted
// here that the caller does not already have.
//
// Owner/admin gated, and deliberately NOT automatic: the identity gate exists to
// stop a non-member acting, and any app that can post in the channel is a
// non-member. Turning that off by default would reintroduce exactly the
// impersonation SLACK_REQUIRE_USER_IDENTITY was added to prevent.
async function slashLinkBot(ctx: SlashCtx, arg: string): Promise<SlashResponse> {
  const selection = await currentChannelSelection(ctx);
  if (!selection?.projectId) {
    return { response_type: 'ephemeral', text: `No project bound to this channel. Run \`${ctx.command} switch\` first.` };
  }
  const me = await lookupChatIdentity(slackUserOf(ctx));
  if (!me) {
    return { response_type: 'ephemeral', text: `Connect your own Kortix account first: \`${ctx.command} login\`.` };
  }
  const token = await loadSlackTokenForProject(selection.projectId);
  if (!token) {
    return { response_type: 'ephemeral', text: 'Slack is not fully connected for this project yet.' };
  }
  // THREE INPUT FORMS, because only one of them is what an operator will type.
  // The slash command is registered should_escape:false, so Slack sends
  // "@Incident reporter" LITERALLY — it is never expanded to <@U…>. The first
  // version of this accepted only an id and its usage text said `link-bot
  // @TheBot`, i.e. it documented the one form that cannot work. Reported from
  // the channel: "Usage: ..." came back for exactly that.
  const raw = arg.trim();
  let botUserId = raw.replace(/^<@|[|>].*$/g, '').toUpperCase();
  if (!/^[UWB][A-Z0-9]{6,}$/.test(botUserId)) {
    const byName = await findBotUserIdByName(token, raw);
    if (!byName) {
      return {
        response_type: 'ephemeral',
        text: `Couldn't find a bot called \`${raw || '…'}\`.\n`
          + `Try the member ID instead: open the bot's profile → **⋮** → *Copy member ID*, then `
          + `\`${ctx.command} link-bot U01234ABCDE\`.\n`
          + `_(Typing @Name works only if the name matches exactly — Slack sends it to this command as plain text, not a mention.)_`,
      };
    }
    botUserId = byName;
  }
  // GATE: "could you have done this work yourself?" — NOT "are you an admin?".
  //
  // Linking binds the bot to the CALLER's own account (userId: me.userId below,
  // and a bot already linked to someone else is refused), so it delegates the
  // caller's authority and can never exceed it. That makes it the same shape as
  // issuing yourself an API key, and an owner/admin requirement actively wrong:
  // an admin linking a bot that anyone in the channel can trigger is strictly
  // MORE dangerous than a regular member doing the same.
  //
  // So the check is the one resolveChatActor already performs for every Slack
  // message — linked identity, member of this project's account, PROJECT_WRITE.
  // Anyone who can @-mention the agent and have it act can delegate exactly that
  // and nothing more. Reusing it also means the two can never disagree: if this
  // passes, the bot's mentions will resolve; if it fails, they would not have.
  const actor = await resolveProjectChatActor(slackUserOf(ctx), selection.projectId);
  if ('reason' in actor) {
    return {
      response_type: 'ephemeral',
      text: actor.reason === 'not_member'
        ? "You're connected, but don't have access to this project yet."
        : `Connect your Kortix account first: \`${ctx.command} login\`.`,
    };
  }
  // A HUMAN's id must never be bound here. linkChatIdentity upserts, and
  // resolveChatActor treats the row as authoritative, so linking a person would
  // silently make THEIR later Slack actions run as whoever linked them — the
  // exact impersonation SLACK_REQUIRE_USER_IDENTITY exists to prevent, through a
  // different door. Human and bot ids are the same shape (U…/W…), so only Slack
  // can tell them apart. Flagged on #6590 by review; it was a real hole.
  const existing = await lookupChatIdentity(chatUser('slack', ctx.teamId, botUserId));
  if (existing && existing.userId !== me.userId) {
    return { response_type: 'ephemeral', text: `<@${botUserId}> is already linked to a different Kortix account. Have them disconnect first.` };
  }
  const bot = await isBotUser(token, botUserId);
  if (bot !== true) {
    // null = we could not tell (missing scope, transport error, unknown user).
    // Refuse either way: guessing is the impersonation.
    return {
      response_type: 'ephemeral',
      text: bot === false
        ? `<@${botUserId}> is a person, not a bot. \`link-bot\` only accepts an app — a person connects their own account with \`${ctx.command} login\`.`
        : `Could not verify <@${botUserId}> with Slack. Nothing was linked; try again.`,
    };
  }
  await linkChatIdentity(chatUser('slack', ctx.teamId, botUserId), me.userId);
  return {
    response_type: 'ephemeral',
    text: `Linked <@${botUserId}> to your Kortix account. Its @-mentions of Kortix in this workspace now run as you. Undo with \`${ctx.command} logout\` semantics via support, or re-link to someone else.`,
  };
}

// ── Login / Logout ───────────────────────────────────────────────────────────
// Bind this Slack user to their OWN Kortix account so the agent runs as them
// (their credentials/secrets/connectors) instead of the workspace owner. The
// link opens an authenticated web page that completes the bind; nothing is
// stored until the user logs in there.
async function slashLogin(ctx: SlashCtx): Promise<SlashResponse> {
  if (!ctx.slackUserId) {
    return { response_type: 'ephemeral', text: "I couldn't tell who you are from Slack — try again from a channel or DM." };
  }
  const existing = await lookupChatIdentity(slackUserOf(ctx));
  const url = buildSlackLoginUrl({ teamId: ctx.teamId, slackUserId: ctx.slackUserId });
  return {
    response_type: 'ephemeral',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: existing
            ? '*Your Slack is already connected to a Kortix account.*\nClick below to re-connect (e.g. to switch accounts). The link expires in 10 minutes.'
            : '*Connect your Kortix account.*\nKortix needs access to your account before it can run from Slack. The link expires in 10 minutes and is private to you.',
        },
      },
      {
        type: 'actions',
        elements: [
          {
          type: 'button',
            text: { type: 'plain_text', text: existing ? 'Re-connect Kortix' : 'Connect or create account', emoji: true },
            style: 'primary',
            url,
            action_id: 'slack_login_connect',
          },
        ],
      },
    ],
  };
}

async function slashLogout(ctx: SlashCtx): Promise<SlashResponse> {
  if (!ctx.slackUserId) {
    return { response_type: 'ephemeral', text: "I couldn't tell who you are from Slack — try again from a channel or DM." };
  }
  const revoked = await revokeChatIdentity(slackUserOf(ctx));
  return {
    response_type: 'ephemeral',
    text: revoked
      ? "Disconnected. Kortix will ask you to connect again before it runs on your behalf. Run `/kortix login` anytime."
      : "You weren't connected. Run `/kortix login` to connect your Kortix account.",
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
