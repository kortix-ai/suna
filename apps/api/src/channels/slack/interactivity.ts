import type { Effect } from 'effect';
import { and, eq } from 'drizzle-orm';
import { chatChannelBindings, chatInstalls, chatThreads, projects } from '@kortix/db';
import { sharedConfig as config, sharedDb as db } from '../../shared/effect';
import { loadSlackTokenForProject } from '../install-store';
import { updateMessage } from '../slack-api';
import { dispatchSlackEvent, pendingPickers, spawnAgentTurn } from './dispatch';
import { createSlackAccessRequest, notifyAdminsOfAccessRequest } from './identity';
import { decideSlackThreadJoin } from './participants';
import { attachPendingSlackAuthResponseUrl } from './auth-resume';
import { verifyLoginState } from './login';
import { escapeMrkdwn, respondViaUrl, sessionWebUrl } from './util';
import { setChannelAgent, setChannelModel } from './selection';
import { channelModelContext } from './model-gate';
import { type SlashCtx, handleSlashCommand } from './commands';
import { labelForModelRef } from '../../llm-gateway/models/picker';
import { isModelServableForAccount } from '../../llm-gateway/resolution/default-model';
import { toOpencodeModelRef } from '../../llm-gateway/resolution/effective';
import type { SlackEnvelope, SlackEvent, SlackInteractionPayload } from './types';

// Agent-emitted button click (carousel cards, actions blocks). Routes the
// click back into the thread as a synthesized follow-up so the agent's next
// turn picks up from the user's choice.
async function handleAgentClick(
  payload: SlackInteractionPayload,
  action: NonNullable<SlackInteractionPayload['actions']>[number],
): Promise<void> {
  const teamId = payload.team?.id ?? '';
  const channelId = payload.channel?.id ?? '';
  const userId = payload.user?.id ?? '';
  const messageTs = payload.message?.ts ?? '';
  const threadTs = payload.message?.thread_ts ?? messageTs;
  if (!teamId || !channelId || !userId || !threadTs) return;

  const label = (action.text?.text ?? action.action_id ?? '').trim();
  const value = (action.value ?? '').trim();

  await respondViaUrl(payload.response_url, {
    response_type: 'ephemeral',
    text: `On it — picked *${label || action.action_id}*.`,
  });

  const [thread] = await db
    .select({ projectId: chatThreads.projectId })
    .from(chatThreads)
    .where(and(
      eq(chatThreads.platform, 'slack'),
      eq(chatThreads.workspaceId, teamId),
      eq(chatThreads.threadId, threadTs),
    ))
    .limit(1);
  if (!thread) return;

  const lines = [`[Button click] The user clicked *${label || action.action_id}*.`];
  if (action.action_id) lines.push(`action_id: \`${action.action_id}\``);
  if (value) lines.push(`value: \`${value}\``);
  lines.push('', 'Continue the turn based on this choice.');

  const event: SlackEvent = {
    type: 'message',
    user: userId,
    channel: channelId,
    text: lines.join('\n'),
    ts: messageTs,
    thread_ts: threadTs,
    team: teamId,
  };
  const envelope: SlackEnvelope = {
    type: 'event_callback',
    team_id: teamId,
    event,
  };
  await spawnAgentTurn(thread.projectId, envelope, event);
}

// A click on one of the agent's `question` options (rendered as buttons by
// buildQuestionBlocks, action_id `qa_<q>_<o>`). Resolve the original message to a
// confirmation so it can't be re-clicked, then resume the thread's session with
// the chosen answer as a follow-up turn — the SAME path an in-thread reply takes,
// so questions behave natively in Slack instead of dead-ending.
async function handleQuestionAnswer(
  payload: SlackInteractionPayload,
  action: NonNullable<SlackInteractionPayload['actions']>[number],
): Promise<void> {
  const teamId = payload.team?.id ?? '';
  const channelId = payload.channel?.id ?? '';
  const userId = payload.user?.id ?? '';
  const messageTs = payload.message?.ts ?? '';
  const threadTs = payload.message?.thread_ts ?? messageTs;
  if (!teamId || !channelId || !userId || !threadTs) return;

  let parsed: { q?: string; a?: string } = {};
  try {
    parsed = JSON.parse(action.value ?? '{}') as { q?: string; a?: string };
  } catch {
    parsed = {};
  }
  const label = (parsed.a ?? action.text?.text ?? '').trim();
  const question = (parsed.q ?? '').trim();

  // Ephemeral ack only — NOT replace_original. A message may carry several
  // questions; replacing it would wipe the sibling questions' buttons. (Matches
  // handleAgentClick.) The buttons stay; a re-click just sends another follow-up.
  await respondViaUrl(payload.response_url, {
    response_type: 'ephemeral',
    text: `On it — *${escapeMrkdwn(label)}*.`,
  });

  const [thread] = await db
    .select({ projectId: chatThreads.projectId })
    .from(chatThreads)
    .where(and(
      eq(chatThreads.platform, 'slack'),
      eq(chatThreads.workspaceId, teamId),
      eq(chatThreads.threadId, threadTs),
    ))
    .limit(1);
  if (!thread) return;

  const lines: string[] = [];
  if (question) lines.push(`Answering your question "${question}":`);
  lines.push(label || 'see the selection above');
  lines.push('', 'Continue the turn based on this answer.');

  const event: SlackEvent = {
    type: 'message',
    user: userId,
    channel: channelId,
    text: lines.join('\n'),
    ts: messageTs,
    thread_ts: threadTs,
    team: teamId,
  };
  const envelope: SlackEnvelope = { type: 'event_callback', team_id: teamId, event };
  await spawnAgentTurn(thread.projectId, envelope, event);
}

async function handleSwitchProject(payload: SlackInteractionPayload, rawValue: string): Promise<void> {
  let value: { p?: string; c?: string };
  try {
    value = JSON.parse(rawValue || '{}') as { p?: string; c?: string };
  } catch {
    return;
  }
  const projectId = value.p;
  const channelId = value.c ?? payload.channel?.id;
  const teamId = payload.team?.id ?? '';
  if (!projectId || !channelId || !teamId) return;

  const [install] = await db
    .select({ id: chatInstalls.installId })
    .from(chatInstalls)
    .where(and(
      eq(chatInstalls.platform, 'slack'),
      eq(chatInstalls.workspaceId, teamId),
      eq(chatInstalls.projectId, projectId),
    ))
    .limit(1);
  if (!install) {
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      replace_original: true,
      text: 'That project is no longer connected to this workspace.',
    });
    return;
  }

  await db
    .insert(chatChannelBindings)
    .values({ platform: 'slack', workspaceId: teamId, channelId, projectId, pickerTs: null })
    .onConflictDoUpdate({
      target: [chatChannelBindings.platform, chatChannelBindings.workspaceId, chatChannelBindings.channelId],
      set: { projectId, pickerTs: null },
    });

  const [p] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);

  await respondViaUrl(payload.response_url, {
    response_type: 'ephemeral',
    replace_original: true,
    text: `Switched this channel to *${p?.name ?? 'project'}*.`,
  });
}

// Pick an agent/model from the `/kortix agents` or `/kortix models` picker.
// The value carries the channel + selection ('' = clear → project default).
async function handleSetSelection(
  payload: SlackInteractionPayload,
  rawValue: string,
  kind: 'agent' | 'model',
): Promise<void> {
  let value: { c?: string; a?: string; m?: string };
  try {
    value = JSON.parse(rawValue || '{}') as { c?: string; a?: string; m?: string };
  } catch {
    return;
  }
  const teamId = payload.team?.id ?? '';
  const channelId = value.c ?? payload.channel?.id ?? '';
  if (!teamId || !channelId) return;
  const ctx = { teamId, channelId };

  if (kind === 'agent') {
    const agentName = value.a && value.a.length > 0 ? value.a : null;
    const ok = await setChannelAgent(ctx, agentName);
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      replace_original: true,
      text: !ok
        ? 'That channel is no longer bound to a project — run `/kortix switch` first.'
        : agentName
          ? `✓ Agent for this channel set to *${escapeMrkdwn(agentName)}*. New sessions will use it.`
          : '✓ Agent reset to the project default.',
    });
    return;
  }

  const requested = value.m && value.m.length > 0 ? value.m : null;
  if (!requested) {
    const ok = await setChannelModel(ctx, null);
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      replace_original: true,
      text: ok
        ? '✓ Model reset to the project default.'
        : 'That channel is no longer connected to a project — run `/kortix` first.',
    });
    return;
  }
  // Picker options are already servable, but re-validate before persisting so a
  // stored model can NEVER 404 at request time ("model isn't available").
  const gate = await channelModelContext(ctx);
  if (gate) {
    const servable = await isModelServableForAccount({
      userId: gate.ownerUserId,
      accountId: gate.accountId,
      projectId: gate.projectId,
      freeModelsOnly: gate.freeManagedOnly,
      model: requested,
    });
    if (!servable) {
      await respondViaUrl(payload.response_url, {
        response_type: 'ephemeral',
        replace_original: true,
        text: `⚠️ \`${escapeMrkdwn(requested)}\` isn't available for this workspace. Pick another, or connect that provider's API key in Kortix.`,
      });
      return;
    }
  }
  const stored = toOpencodeModelRef(requested);
  const ok = await setChannelModel(ctx, stored);
  await respondViaUrl(payload.response_url, {
    response_type: 'ephemeral',
    replace_original: true,
    text: ok
      ? `✓ Model for this channel set to *${escapeMrkdwn(labelForModelRef(stored))}* (\`${escapeMrkdwn(stored)}\`). New sessions will use it.`
      : 'That channel is no longer connected to a project — run `/kortix` first.',
  });
}

// A `/kortix` panel "Change model/agent/project" button. Re-runs the matching
// slash subcommand for the channel and replaces the panel with that picker, so
// the whole config flow lives behind one command + inline buttons.
async function handleConfigOpen(
  payload: SlackInteractionPayload,
  actionId: 'cfg_open_models' | 'cfg_open_agents' | 'cfg_open_projects',
): Promise<void> {
  const teamId = payload.team?.id ?? '';
  const channelId = payload.channel?.id ?? '';
  if (!teamId || !channelId || !payload.response_url) return;
  const sub = actionId === 'cfg_open_models' ? 'models' : actionId === 'cfg_open_agents' ? 'agents' : 'switch';
  const ctx: SlashCtx = {
    teamId,
    channelId,
    slackUserId: payload.user?.id ?? '',
    command: '/kortix',
    responseUrl: payload.response_url,
  };
  // `agents` defers internally (git) and posts the real picker via responseUrl;
  // its sync return is a "Loading…" ack. `models`/`switch` return full blocks.
  const resp = await handleSlashCommand(sub, '', ctx);
  await respondViaUrl(payload.response_url, { ...resp, replace_original: true });
}

// Message shortcut ("Open in Kortix", callback_id `open_session`). Resolves the
// thread the message lives in to its Kortix session and replies (ephemerally)
// with a link. Unlike a slash command, a message shortcut DOES carry the
// message's thread_ts, so this can answer "which session is THIS thread".
export async function handleMessageShortcut(payload: SlackInteractionPayload): Promise<void> {
  if (payload.callback_id !== 'open_session') return;
  const teamId = payload.team?.id ?? '';
  const messageTs = payload.message?.ts ?? '';
  const threadTs = payload.message?.thread_ts ?? messageTs;
  if (!teamId || !threadTs) {
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      text: "Couldn't read that message's thread.",
    });
    return;
  }

  const [thread] = await db
    .select({ sessionId: chatThreads.sessionId, projectId: chatThreads.projectId })
    .from(chatThreads)
    .where(and(
      eq(chatThreads.platform, 'slack'),
      eq(chatThreads.workspaceId, teamId),
      eq(chatThreads.threadId, threadTs),
    ))
    .limit(1);
  if (!thread) {
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      text: 'No Kortix session is attached to this thread yet. `@`-mention me to start one.',
    });
    return;
  }

  const url = sessionWebUrl(config.FRONTEND_URL, thread.projectId, thread.sessionId);
  await respondViaUrl(payload.response_url, {
    response_type: 'ephemeral',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: '*This thread\'s Kortix session*' } },
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
  });
}

// "Request access" (the ephemeral nudge for a connected-but-no-access user) →
// file a project access request and ping the account's admins. Replaces the
// ephemeral in place via the interaction's response_url so the user gets an
// immediate, only-visible-to-them confirmation.
async function handleRequestAccess(payload: SlackInteractionPayload, value: string): Promise<void> {
  const teamId = payload.team?.id ?? '';
  const slackUserId = payload.user?.id ?? '';
  let projectId = '';
  try {
    projectId = (JSON.parse(value || '{}') as { projectId?: string }).projectId ?? '';
  } catch {
    projectId = '';
  }
  if (!teamId || !slackUserId || !projectId) return;

  const result = await createSlackAccessRequest({ teamId, slackUserId, projectId });
  const message =
    result.status === 'created'
      ? "Access requested ✓ — an admin will review it. Once you're approved, send your message again and I'll get on it."
      : result.status === 'pending'
        ? "You've already requested access — it's pending an admin's review."
        : result.status === 'already-member'
          ? 'You already have access — send your message again and I’ll get on it.'
          : 'I couldn’t request access — connect your Kortix account first, then try again.';
  await respondViaUrl(payload.response_url, { replace_original: true, text: message });

  if (result.status === 'created') {
    await notifyAdminsOfAccessRequest({
      teamId,
      projectId,
      accountId: result.accountId,
      requesterUserId: result.requesterUserId,
      requesterSlackUserId: slackUserId,
    });
  }
}

async function handleThreadJoinDecision(
  payload: SlackInteractionPayload,
  value: string,
  decision: 'approved' | 'denied',
): Promise<void> {
  const teamId = payload.team?.id ?? '';
  const channelId = payload.channel?.id ?? '';
  const deciderSlackUserId = payload.user?.id ?? '';
  let parsed: {
    projectId?: string;
    sessionId?: string;
    threadId?: string;
    requesterUserId?: string;
    requesterSlackUserId?: string;
  } = {};
  try {
    parsed = JSON.parse(value || '{}') as typeof parsed;
  } catch {
    parsed = {};
  }
  if (
    !teamId ||
    !channelId ||
    !deciderSlackUserId ||
    !parsed.projectId ||
    !parsed.sessionId ||
    !parsed.threadId ||
    !parsed.requesterUserId ||
    !parsed.requesterSlackUserId
  ) {
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      text: 'I could not read that approval request. Ask the person to request access again.',
    });
    return;
  }

  const result = await decideSlackThreadJoin({
    teamId,
    channelId,
    deciderSlackUserId,
    projectId: parsed.projectId,
    sessionId: parsed.sessionId,
    threadId: parsed.threadId,
    requesterUserId: parsed.requesterUserId,
    requesterSlackUserId: parsed.requesterSlackUserId,
    decision,
  });
  await respondViaUrl(payload.response_url, {
    response_type: 'ephemeral',
    replace_original: true,
    text: result.text,
  });
}

function loginActionValue(action: NonNullable<SlackInteractionPayload['actions']>[number]): {
  pendingId?: string;
  url?: string;
} {
  try {
    const parsed = JSON.parse(action.value || '{}') as { pendingId?: string; url?: string };
    return {
      ...(typeof parsed.pendingId === 'string' && parsed.pendingId ? { pendingId: parsed.pendingId } : {}),
      ...(typeof parsed.url === 'string' && parsed.url ? { url: parsed.url } : {}),
    };
  } catch {
    // Fall back to parsing the URL below for prompts generated before the
    // first-button action flow existed.
  }
  const token = action.url?.split('/identity/login/')[1]?.split(/[?#]/)[0]
    ?? action.url?.split('/slack/login/')[1]?.split(/[?#]/)[0];
  return {
    ...(token ? { pendingId: verifyLoginState(token)?.pendingId } : {}),
    ...(action.url ? { url: action.url } : {}),
  };
}

async function handleSlackLoginConnect(
  payload: SlackInteractionPayload,
  action: NonNullable<SlackInteractionPayload['actions']>[number],
): Promise<void> {
  const login = loginActionValue(action);
  const teamId = payload.team?.id ?? '';
  const slackUserId = payload.user?.id ?? '';
  await attachPendingSlackAuthResponseUrl({
    pendingId: login.pendingId,
    teamId,
    slackUserId,
    responseUrl: payload.response_url,
  });
  await respondViaUrl(payload.response_url, {
    response_type: 'ephemeral',
    replace_original: true,
    text: 'Opening Kortix to connect your account...',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: login.url
            ? `*Open Kortix to connect your account.*\n<${login.url}|Continue in Kortix>. This message will update when the connection is complete.`
            : '*Open Kortix to connect your account.*\nRun `/kortix login` if this button expired.',
        },
      },
      ...(login.url
        ? [{
          type: 'actions',
          elements: [{
            type: 'button',
            text: { type: 'plain_text', text: 'Open Kortix', emoji: true },
            style: 'primary',
            url: login.url,
            action_id: 'slack_login_open',
          }],
        }]
        : []),
    ],
  });
}

export async function handleBlockAction(payload: SlackInteractionPayload): Promise<void> {
  const action = payload.actions?.[0];
  if (!action?.action_id) return;

  if (action.action_id.startsWith('qa_')) {
    await handleQuestionAnswer(payload, action);
    return;
  }

  if (action.action_id.startsWith('set_agent')) {
    await handleSetSelection(payload, action.value ?? '', 'agent');
    return;
  }

  if (action.action_id.startsWith('set_model')) {
    await handleSetSelection(payload, action.value ?? '', 'model');
    return;
  }

  // `/kortix` panel "Change …" buttons re-render the focused picker in place.
  if (
    action.action_id === 'cfg_open_models' ||
    action.action_id === 'cfg_open_agents' ||
    action.action_id === 'cfg_open_projects'
  ) {
    await handleConfigOpen(payload, action.action_id);
    return;
  }

  // URL buttons (open a link) — swallow so they don't fall to the agent-click
  // catch-all and get echoed back into a thread.
  if (
    action.action_id.startsWith('panel_open_') ||
    action.action_id.startsWith('whoami_open_') ||
    action.action_id.startsWith('whoami_repo_')
  ) {
    return;
  }

  // A plain "Open session ↗" link button carries a `url` and needs no handling.
  if (action.action_id === 'session_open') return;

  // Identity / access nudges. "Connect" and "Review in Kortix" are URL buttons —
  // they open a link, so swallow their block_action so it doesn't fall through to
  // the agent-click catch-all below. "Request access" does real work.
  if (action.action_id === 'slack_login_connect') {
    await handleSlackLoginConnect(payload, action);
    return;
  }
  if (action.action_id === 'slack_open_access_review') {
    return;
  }
  if (action.action_id === 'slack_request_access') {
    await handleRequestAccess(payload, action.value ?? '');
    return;
  }

  if (action.action_id === 'slack_thread_join_approve') {
    await handleThreadJoinDecision(payload, action.value ?? '', 'approved');
    return;
  }
  if (action.action_id === 'slack_thread_join_deny') {
    await handleThreadJoinDecision(payload, action.value ?? '', 'denied');
    return;
  }

  if (action.action_id.startsWith('switch_project_')) {
    await handleSwitchProject(payload, action.value ?? '');
    return;
  }

  // Anything else is an agent-emitted button (typically inside a carousel card
  // or actions block from `slack send --blocks-file ...`). Route the click back
  // into the thread as a synthesized follow-up so the agent can continue.
  if (!action.action_id.startsWith('pick_project') && !action.action_id.startsWith('switch_project_')) {
    await handleAgentClick(payload, action);
    return;
  }

  if (!action.action_id.startsWith('pick_project')) return;
  let value: { k?: string; p?: string };
  try {
    value = JSON.parse(action.value ?? '{}') as { k?: string; p?: string };
  } catch {
    return;
  }
  const pickerId = value.k;
  const projectId = value.p;
  const teamId = payload.team?.id ?? '';
  const channelId = payload.channel?.id ?? '';
  const pickerTs = payload.message?.ts ?? '';
  if (!pickerId || !projectId || !teamId || !channelId) return;

  const token = await loadSlackTokenForProject(projectId);

  const stillInstalled = await db
    .select({ id: chatInstalls.installId })
    .from(chatInstalls)
    .where(
      and(
        eq(chatInstalls.platform, 'slack'),
        eq(chatInstalls.workspaceId, teamId),
        eq(chatInstalls.projectId, projectId),
      ),
    )
    .limit(1);
  if (stillInstalled.length === 0) {
    if (token && pickerTs) {
      await updateMessage(
        token,
        channelId,
        pickerTs,
        'That project is no longer connected here — @mention me again to pick another.',
      );
    }
    return;
  }

  await db
    .update(chatChannelBindings)
    .set({ projectId, pickerTs: null })
    .where(
      and(
        eq(chatChannelBindings.platform, 'slack'),
        eq(chatChannelBindings.workspaceId, teamId),
        eq(chatChannelBindings.channelId, channelId),
      ),
    );

  const [proj] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (token && pickerTs) {
    // DM channel ids start with 'D' — a <#D…> mention renders as a dead link
    // there, so phrase it as "this DM" instead of a channel mention.
    const target = channelId.startsWith('D') ? 'this DM' : `<#${channelId}>`;
    await updateMessage(
      token,
      channelId,
      pickerTs,
      `✓ Linked ${target} to *${proj?.name ?? 'project'}*.`,
    );
  }

  const pending = pendingPickers.get(pickerId);
  if (pending) {
    pendingPickers.delete(pickerId);
    await dispatchSlackEvent(projectId, pending.envelope);
  }
}
