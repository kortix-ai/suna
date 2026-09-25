import { TURN_INSTRUCTIONS } from './session';
import { and, eq } from 'drizzle-orm';
import { chatChannelBindings, chatInstalls, projectSessions, projects } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import { loadSlackTokenForProject } from '../install-store';
import { openModal, updateMessage } from '../slack-api';
import { backfillChannelName, dispatchSlackEvent, pendingPickers, spawnAgentTurn } from './dispatch';
import { createSlackAccessRequest, notifyAdminsOfAccessRequest, resolveSlackActor } from './identity';
import { parseReviewActionId, reviewVerbToVerdict, type ReviewVerb } from './review-cards';
import {
  REVIEW_FEEDBACK_CALLBACK,
  buildReviewFeedbackView,
  decodeReviewMetadata,
  readReviewFeedback,
} from './review-modal';
import { applyVerdict, getReviewItemById } from '../../projects/review-items';
import { SLACK_STOP_ACTION, stopSlackTurn } from './stop';
import { isAdaptedId } from '../../projects/review-adapters';
import { decideSlackThreadJoin } from './participants';
import { attachPendingSlackAuthResponseUrl } from './auth-resume';
import { verifyLoginState } from './login';
import { escapeMrkdwn, respondViaUrl, sessionWebUrl } from './util';
import { setChannelAgent } from './selection';
import { applySlackModelChoice } from './model-choice';
import { type SlashCtx, currentChannelProjectId, handleSlashCommand } from './commands';
import {
  CANONICAL_SLACK_INBOUND,
  findSlackThread,
  inboundAllowsProject,
  inboundAllowsTeam,
  inboundProjectId,
  type SlackInbound,
} from './inbound';
import type { SlackEnvelope, SlackEvent, SlackInteractionPayload } from './types';

const OTHER_PROJECT_NOTICE = 'This Slack app is tied to a different Kortix project.';

/** spawnAgentTurn options for a request from `inbound`. */
function turnScope(inbound: SlackInbound): { ownThreadsOnly: boolean } {
  return { ownThreadsOnly: inbound.kind === 'project' };
}

// Agent-emitted button click (carousel cards, actions blocks). Routes the
// click back into the thread as a synthesized follow-up so the agent's next
// turn picks up from the user's choice.
async function handleAgentClick(
  payload: SlackInteractionPayload,
  action: NonNullable<SlackInteractionPayload['actions']>[number],
  inbound: SlackInbound,
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

  const thread = await findSlackThread(inbound, teamId, threadTs);
  if (!thread) {
    // The button lives on a message with no session thread behind it —
    // typically an actions block the agent posted top-level with
    // `slack send --channel` and no `--thread`. The user already saw "On it";
    // dropping silently here is how a click turned into nothing.
    console.warn('[slack-webhook] button click dropped — no session thread for message', {
      teamId,
      channelId,
      threadTs,
      actionId: action.action_id,
    });
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      text: "This button isn't attached to a Kortix thread, so nothing can pick it up. Reply in the session's thread instead.",
    });
    return;
  }

  // A click is a full turn: it gets the same channel/thread header and the
  // same working instructions a message turn gets, so the agent knows it must
  // stream progress with `slack step` and close the turn with `slack send`.
  const lines = [
    "You're answering a button click on Slack as a teammate.",
    '',
    `Workspace:  ${teamId}`,
    `Channel:    ${channelId}`,
    `User:       ${userId}`,
    `Thread ts:  ${threadTs}`,
    '',
    `[Button click] The user clicked *${label || action.action_id}*.`,
  ];
  if (action.action_id) lines.push(`action_id: \`${action.action_id}\``);
  if (value) lines.push(`value: \`${value}\``);
  lines.push('', 'Continue the turn based on this choice.', '', TURN_INSTRUCTIONS);

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
  await spawnAgentTurn(thread.projectId, envelope, event, turnScope(inbound));
}

// A click on one of the agent's `question` options (rendered as buttons by
// buildQuestionBlocks, action_id `qa_<q>_<o>`). Resolve the original message to a
// confirmation so it can't be re-clicked, then resume the thread's session with
// the chosen answer as a follow-up turn — the SAME path an in-thread reply takes,
// so questions behave natively in Slack instead of dead-ending.
async function handleQuestionAnswer(
  payload: SlackInteractionPayload,
  action: NonNullable<SlackInteractionPayload['actions']>[number],
  inbound: SlackInbound,
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

  const thread = await findSlackThread(inbound, teamId, threadTs);
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
  await spawnAgentTurn(thread.projectId, envelope, event, turnScope(inbound));
}

// A click on a Review Center card button (rendered by buildReviewCardBlocks,
// action_id `review_<verb>_<id>`). Apply the human's verdict to the review item,
// ack ephemerally, then resume the waiting session with the decision as a
// follow-up turn — the SAME path a question answer takes (handleQuestionAnswer),
// so a Slack-submitted review behaves natively instead of dead-ending.
async function handleReviewAction(
  payload: SlackInteractionPayload,
  parsed: { verb: ReviewVerb; id: string },
  inbound: SlackInbound,
): Promise<void> {
  const teamId = payload.team?.id ?? '';
  const channelId = payload.channel?.id ?? '';
  const slackUserId = payload.user?.id ?? '';
  const messageTs = payload.message?.ts ?? '';
  const threadTs = payload.message?.thread_ts ?? messageTs;
  if (!teamId || !channelId || !slackUserId || !threadTs) return;

  // 'view' is a link button (opens Kortix) — Slack still fires its block_action,
  // but there's nothing to apply.
  const verdict = reviewVerbToVerdict(parsed.verb);
  if (!verdict) return;

  // Adapted items (change requests, connector approvals) keep their own act flow —
  // their verdict can't be applied through the native review path.
  if (isAdaptedId(parsed.id)) {
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      text: 'Open this item in Kortix to act on it.',
    });
    return;
  }

  // Resolve the thread → its project so we can scope the item + the actor.
  const thread = await findSlackThread(inbound, teamId, threadTs);
  if (!thread) return;

  // "Request changes" is useless without saying what to change, and Slack has
  // no way to put a box on the posted message — only a modal. Open it here and
  // apply the verdict on submit instead.
  //
  // ORDERING: `trigger_id` expires in ~3 seconds. Everything before
  // `views.open` spends that budget, so the item lookup and the authorization
  // check deliberately happen on SUBMIT, not here — a refusal the reviewer
  // reads after typing is far better than a button that silently does nothing
  // for everyone. The submit path re-resolves and re-authorizes from scratch.
  if (verdict === 'changes' && payload.trigger_id) {
    const token = await loadSlackTokenForProject(thread.projectId);
    if (token) {
      const opened = await openModal(
        token,
        payload.trigger_id,
        buildReviewFeedbackView({
          title: parsed.id,
          metadata: {
            reviewItemId: parsed.id,
            projectId: thread.projectId,
            teamId,
            threadTs,
            channelId,
            messageTs,
            responseUrl: payload.response_url,
          },
        }),
      );
      if (opened) return;
      // The modal could not open (expired trigger, missing scope). Fall through
      // and apply the verdict without feedback — the old behaviour — rather
      // than dropping the reviewer's decision on the floor.
    }
  }

  const item = await getReviewItemById(parsed.id, thread.projectId);
  if (!item) {
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      text: 'That review item is no longer available.',
    });
    return;
  }

  // The actor must be a linked Kortix user with write access to this project.
  // Self-approve is allowed (launcher or any manager) — there's no separation-of-
  // duties gate. No live mapping → nudge to connect / request access.
  const actor = await resolveSlackActor(teamId, slackUserId, item.accountId, thread.projectId);
  if ('reason' in actor) {
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      text:
        actor.reason === 'unlinked'
          ? 'Connect your Kortix account first (`/kortix login`) to act on reviews.'
          : "You don't have access to act on this project's reviews.",
    });
    return;
  }

  await applyVerdict(parsed.id, thread.projectId, {
    verdict,
    feedback: null,
    actingUserId: actor.userId,
  });

  // Ephemeral ack only (NOT replace_original) — keep the card so a sibling button
  // or a re-click still works, mirroring handleQuestionAnswer.
  const title = escapeMrkdwn(item.title);
  await respondViaUrl(payload.response_url, {
    response_type: 'ephemeral',
    text:
      verdict === 'approve'
        ? `Approved *${title}* ✓ — resuming the agent.`
        : verdict === 'reject'
          ? `Rejected *${title}*.`
          : `Asked for changes on *${title}*.`,
  });

  // Resume the session with the decision as a follow-up turn (same path as a
  // question answer / an in-thread reply). spawnAgentTurn re-checks the clicker's
  // access from event.user, so this can't run as anyone but them.
  const decisionLine =
    verdict === 'approve'
      ? `The review "${item.title}" was approved.`
      : verdict === 'reject'
        ? `The review "${item.title}" was rejected — do not proceed with it.`
        : `Changes were requested on the review "${item.title}". Ask what to change, then revise.`;

  const event: SlackEvent = {
    type: 'message',
    user: slackUserId,
    channel: channelId,
    text: [decisionLine, '', 'Continue the turn based on this decision.'].join('\n'),
    ts: messageTs,
    thread_ts: threadTs,
    team: teamId,
  };
  const envelope: SlackEnvelope = { type: 'event_callback', team_id: teamId, event };
  await spawnAgentTurn(thread.projectId, envelope, event, turnScope(inbound));
}

async function handleSwitchProject(
  payload: SlackInteractionPayload,
  rawValue: string,
  inbound: SlackInbound,
): Promise<void> {
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
  if (!inboundAllowsProject(inbound, projectId)) {
    await respondViaUrl(payload.response_url, { response_type: 'ephemeral', text: OTHER_PROJECT_NOTICE });
    return;
  }

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
  await backfillChannelName(teamId, channelId, projectId);

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
  inbound: SlackInbound,
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
  // A per-project app configures only channels bound to its own project.
  if (inbound.kind === 'project' && (await currentChannelProjectId(ctx)) !== inbound.projectId) {
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      replace_original: true,
      text: OTHER_PROJECT_NOTICE,
    });
    return;
  }

  if (kind === 'agent') {
    const agentName = value.a && value.a.length > 0 ? value.a : null;
    const result = await setChannelAgent(ctx, agentName);
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      replace_original: true,
      text: !result.ok
        ? result.reason === 'unknown_agent'
          ? `"${escapeMrkdwn(agentName ?? '')}" is not a declared agent in this project's manifest.`
          : 'That channel is no longer bound to a project — run `/kortix switch` first.'
        : agentName
          ? `✓ Agent for this channel set to *${escapeMrkdwn(agentName)}*. New sessions will use it.`
          : '✓ Agent reset to the project default.',
    });
    return;
  }

  // One path for `/kortix model <id>` and the picker: checked as the person
  // who clicked, with this conversation's keys (channels/slack/model-choice.ts).
  const text = await applySlackModelChoice(
    { teamId, channelId, slackUserId: payload.user?.id ?? '', command: '/kortix' },
    value.m ?? '',
  );
  await respondViaUrl(payload.response_url, {
    response_type: 'ephemeral',
    replace_original: true,
    text,
  });
}

// A `/kortix` panel "Change model/agent/project" button. Re-runs the matching
// slash subcommand for the channel and replaces the panel with that picker, so
// the whole config flow lives behind one command + inline buttons.
async function handleConfigOpen(
  payload: SlackInteractionPayload,
  actionId: 'cfg_open_models' | 'cfg_open_agents' | 'cfg_open_projects',
  inbound: SlackInbound,
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
    projectScopedProjectId: inboundProjectId(inbound),
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
export async function handleMessageShortcut(
  payload: SlackInteractionPayload,
  inbound: SlackInbound = CANONICAL_SLACK_INBOUND,
): Promise<void> {
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

  const thread = await findSlackThread(inbound, teamId, threadTs);
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
async function handleRequestAccess(
  payload: SlackInteractionPayload,
  value: string,
  inbound: SlackInbound,
): Promise<void> {
  const teamId = payload.team?.id ?? '';
  const slackUserId = payload.user?.id ?? '';
  let projectId = '';
  try {
    projectId = (JSON.parse(value || '{}') as { projectId?: string }).projectId ?? '';
  } catch {
    projectId = '';
  }
  if (!teamId || !slackUserId || !projectId) return;
  if (!inboundAllowsProject(inbound, projectId)) {
    await respondViaUrl(payload.response_url, { replace_original: true, text: OTHER_PROJECT_NOTICE });
    return;
  }

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
  inbound: SlackInbound,
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

  if (!inboundAllowsProject(inbound, parsed.projectId)) {
    await respondViaUrl(payload.response_url, { response_type: 'ephemeral', text: OTHER_PROJECT_NOTICE });
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

/** Does `sessionId` belong to a project `inbound` may act on? */
async function sessionInScope(inbound: SlackInbound, sessionId: string): Promise<boolean> {
  if (inbound.kind === 'canonical') return true;
  const [row] = await db
    .select({ projectId: projectSessions.projectId })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  return inboundAllowsProject(inbound, row?.projectId);
}

/**
 * Stop the run behind the live plan message.
 *
 * The button carries its session id in `value`; nothing about the payload
 * names a turn. `stopSlackTurn` decides whether this person may end it and
 * settles the message, so the reply here is only what the presser is told —
 * ephemeral, because a refusal is nobody else's business.
 */
async function handleStop(
  payload: SlackInteractionPayload,
  action: { value?: string },
  inbound: SlackInbound,
): Promise<void> {
  const sessionId = (action.value ?? '').trim();
  const responseUrl = payload.response_url;
  if (!responseUrl) return;
  if (!sessionId || !(await sessionInScope(inbound, sessionId))) {
    await respondViaUrl(responseUrl, { response_type: 'ephemeral', text: 'That run is no longer available.' });
    return;
  }
  const slackUserId = payload.user?.id ?? '';
  const outcome = await stopSlackTurn({
    sessionId,
    slackUserId,
    // `<@U…>` renders as the member's display name in the thread, and it is
    // the only identity the interaction payload carries here.
    byName: slackUserId ? `<@${slackUserId}>` : undefined,
  });
  await respondViaUrl(responseUrl, {
    response_type: 'ephemeral',
    text: outcome.stopped
      ? outcome.stoppedRuntime
        ? 'Stopped. The agent is no longer working on this.'
        : // The ledger is closed either way; do not claim a reach we did not
          // have. A parked or already-finished sandbox is the usual case.
          'Stopped. The run was already closing on its own.'
      : outcome.notice,
  });
}

/**
 * The "Request changes" modal came back.
 *
 * This is a SEPARATE signed request from the button press, so nothing is
 * carried over: the item is re-resolved and the actor re-authorized here, at
 * the same bar the button path applies. `private_metadata` is Slack echoing
 * back what we wrote — it names the item, it does not vouch for anyone.
 */
export async function handleViewSubmission(
  payload: SlackInteractionPayload,
  inbound: SlackInbound = CANONICAL_SLACK_INBOUND,
): Promise<void> {
  if (payload.view?.callback_id !== REVIEW_FEEDBACK_CALLBACK) return;
  const meta = decodeReviewMetadata(payload.view?.private_metadata);
  const slackUserId = payload.user?.id ?? '';
  if (!meta || !slackUserId) return;
  // `private_metadata` is the request body too: a per-project app may name only
  // its own project and workspace in it.
  if (!inboundAllowsProject(inbound, meta.projectId) || !inboundAllowsTeam(inbound, meta.teamId)) return;

  const notify = async (text: string) => {
    if (meta.responseUrl) await respondViaUrl(meta.responseUrl, { response_type: 'ephemeral', text });
  };

  const item = await getReviewItemById(meta.reviewItemId, meta.projectId);
  if (!item) {
    await notify('That review item is no longer available.');
    return;
  }

  const actor = await resolveSlackActor(meta.teamId, slackUserId, item.accountId, meta.projectId);
  if ('reason' in actor) {
    await notify(
      actor.reason === 'unlinked'
        ? 'Connect your Kortix account first (`/kortix login`) to act on reviews.'
        : "You don't have access to act on this project's reviews.",
    );
    return;
  }

  const feedback = readReviewFeedback(payload.view ?? {});
  await applyVerdict(meta.reviewItemId, meta.projectId, {
    verdict: 'changes',
    feedback,
    actingUserId: actor.userId,
  });

  await notify(
    feedback
      ? `Changes requested on *${escapeMrkdwn(item.title)}* — your note went to the agent.`
      : `Changes requested on *${escapeMrkdwn(item.title)}*.`,
  );

  // Only tell the agent to go asking when there is nothing to read.
  const decisionLine = feedback
    ? `Changes were requested on the review "${item.title}".\n\nReviewer's feedback:\n${feedback}`
    : `Changes were requested on the review "${item.title}". Ask what to change, then revise.`;
  // Resume the agent exactly as the button path does — same synthetic
  // in-thread message, same spawnAgentTurn, which re-checks the clicker's
  // access from event.user so this cannot run as anyone but them.
  const event: SlackEvent = {
    type: 'message',
    user: slackUserId,
    channel: meta.channelId,
    text: [decisionLine, '', 'Continue the turn based on this decision.'].join('\n'),
    ts: meta.messageTs,
    thread_ts: meta.threadTs,
    team: meta.teamId,
  };
  const envelope: SlackEnvelope = { type: 'event_callback', team_id: meta.teamId, event };
  await spawnAgentTurn(meta.projectId, envelope, event, turnScope(inbound));
}

export async function handleBlockAction(
  payload: SlackInteractionPayload,
  inbound: SlackInbound = CANONICAL_SLACK_INBOUND,
): Promise<void> {
  const action = payload.actions?.[0];
  if (!action?.action_id) return;

  if (action.action_id === SLACK_STOP_ACTION) {
    await handleStop(payload, action, inbound);
    return;
  }

  if (action.action_id.startsWith('qa_')) {
    await handleQuestionAnswer(payload, action, inbound);
    return;
  }

  // A Review Center card button (`review_<verb>_<id>`). Apply the verdict + resume.
  if (action.action_id.startsWith('review_')) {
    const parsed = parseReviewActionId(action.action_id);
    if (parsed) await handleReviewAction(payload, parsed, inbound);
    return;
  }

  if (action.action_id.startsWith('set_agent')) {
    await handleSetSelection(payload, action.value ?? '', 'agent', inbound);
    return;
  }

  if (action.action_id.startsWith('set_model')) {
    // A button carries its pick in `value`; the long list's select in `selected_option`.
    await handleSetSelection(payload, action.selected_option?.value ?? action.value ?? '', 'model', inbound);
    return;
  }

  // `/kortix` panel "Change …" buttons re-render the focused picker in place.
  if (
    action.action_id === 'cfg_open_models' ||
    action.action_id === 'cfg_open_agents' ||
    action.action_id === 'cfg_open_projects'
  ) {
    await handleConfigOpen(payload, action.action_id, inbound);
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
    await handleRequestAccess(payload, action.value ?? '', inbound);
    return;
  }

  if (action.action_id === 'slack_thread_join_approve') {
    await handleThreadJoinDecision(payload, action.value ?? '', 'approved', inbound);
    return;
  }
  if (action.action_id === 'slack_thread_join_deny') {
    await handleThreadJoinDecision(payload, action.value ?? '', 'denied', inbound);
    return;
  }

  if (action.action_id.startsWith('switch_project_')) {
    await handleSwitchProject(payload, action.value ?? '', inbound);
    return;
  }

  // Anything else is an agent-emitted button (typically inside a carousel card
  // or actions block from `slack send --blocks-file ...`). Route the click back
  // into the thread as a synthesized follow-up so the agent can continue.
  if (!action.action_id.startsWith('pick_project') && !action.action_id.startsWith('switch_project_')) {
    await handleAgentClick(payload, action, inbound);
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
  if (!inboundAllowsProject(inbound, projectId)) return;

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
    await dispatchSlackEvent(projectId, pending.envelope, turnScope(inbound));
  }
}
