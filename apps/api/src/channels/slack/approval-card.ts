/**
 * The Slack card for a policy-gated connector call.
 *
 * A call an agent makes from a Slack thread used to come back as a bare
 * approval link the agent pasted into the thread; the human saw neither what
 * the call does nor a way to answer in place. The card shows the agent's own
 * description (labelled unverified), the parameters the connector will
 * receive, and Approve / Deny / Reply… buttons. Every decision goes through
 * `decideConnectorApproval` — the same implementation as the web cards.
 */
import {
  type ApprovalDecision,
  approvalResumeText,
  loadApprovalRow,
  normalizeApprovalNote,
} from '../../projects/lib/connector-approval-decision';
import { decideChatApproval } from '../core/approval-decision';
import { chatUser } from '../core/identity';
import { loadSlackTokenForProject } from '../install-store';
import { openModal } from '../slack-api';
import { spawnAgentTurn } from './dispatch';
import { findSlackThread, inboundAllowsProject, inboundAllowsTeam, type SlackInbound } from './inbound';
import type { SlackEnvelope, SlackEvent, SlackInteractionPayload } from './types';
import { escapeMrkdwn, respondViaUrl } from './util';

const PREFIX = 'approval_';
export const APPROVAL_REPLY_CALLBACK = 'approval_reply';
const NOTE_BLOCK = 'approval_note_block';
const NOTE_ACTION = 'approval_note_input';
const DECISION_BLOCK = 'approval_decision_block';
const DECISION_ACTION = 'approval_decision_input';
/** A section's text caps at 3000 characters; stay clear of it. */
const SECTION_MAX = 2800;
const VALUE_MAX = 300;

export type ApprovalCardVerb = 'approve' | 'deny' | 'reply' | 'view';

export function approvalActionId(verb: ApprovalCardVerb, executionId: string): string {
  return `${PREFIX}${verb}_${executionId}`;
}

export function parseApprovalActionId(
  actionId: string,
): { verb: ApprovalCardVerb; executionId: string } | null {
  const match = /^approval_(approve|deny|reply|view)_(.+)$/.exec(actionId);
  if (!match) return null;
  return { verb: match[1] as ApprovalCardVerb, executionId: match[2] };
}

export interface ApprovalCardInput {
  executionId: string;
  actionPath: string;
  risk: string | null;
  argsPreview: Record<string, unknown> | null;
  approvalContext: string | null;
  approvalUrl: string | null;
  /** False when the call recorded nothing to review — Approve is not offered. */
  approvable: boolean;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function renderValue(value: unknown): string {
  if (value === '[redacted]') return '_hidden credential_';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return escapeMrkdwn(clip(text ?? '', VALUE_MAX)).replace(/\n/g, ' ');
}

function parameterLines(argsPreview: Record<string, unknown> | null): string {
  const entries = Object.entries(argsPreview ?? {});
  if (entries.length === 0) return '_No parameters recorded._';
  return clip(entries.map(([key, value]) => `\`${escapeMrkdwn(key)}\`  ${renderValue(value)}`).join('\n'), SECTION_MAX);
}

function quote(text: string): string {
  return clip(escapeMrkdwn(text), SECTION_MAX - 80)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/** The card as posted: header, the agent's description, parameters, buttons. */
export function buildApprovalCardBlocks(card: ApprovalCardInput): unknown[] {
  const risk = card.risk ? ` · _${escapeMrkdwn(card.risk)}_` : '';
  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:shield: *The agent needs your approval* to run \`${escapeMrkdwn(card.actionPath)}\`${risk}`,
      },
    },
  ];
  if (card.approvalContext) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Agent's description* _(written by the agent, not verified)_\n${quote(card.approvalContext)}`,
      },
    });
  }
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*Parameters the connector will receive*\n${parameterLines(card.argsPreview)}` },
  });
  const buttons: unknown[] = [];
  if (card.approvable) {
    buttons.push({
      type: 'button',
      style: 'primary',
      action_id: approvalActionId('approve', card.executionId),
      text: { type: 'plain_text', text: 'Approve' },
      value: card.executionId,
    });
  }
  buttons.push(
    {
      type: 'button',
      style: 'danger',
      action_id: approvalActionId('deny', card.executionId),
      text: { type: 'plain_text', text: 'Deny' },
      value: card.executionId,
    },
    {
      type: 'button',
      action_id: approvalActionId('reply', card.executionId),
      text: { type: 'plain_text', text: 'Reply…' },
      value: card.executionId,
    },
  );
  if (card.approvalUrl) {
    buttons.push({
      type: 'button',
      action_id: approvalActionId('view', card.executionId),
      text: { type: 'plain_text', text: 'Open in Kortix' },
      url: card.approvalUrl,
    });
  }
  blocks.push(
    { type: 'actions', elements: buttons },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: card.approvable
            ? 'Your decision applies to this call only. *Reply…* sends the agent a message with it.'
            : 'This call recorded no parameters, so it can only be denied here.',
        },
      ],
    },
  );
  return blocks;
}

/** What replaces the buttons once anyone decided — here, in Kortix, or on the link page. */
export function buildApprovalOutcomeBlocks(outcome: {
  actionPath: string;
  decision: ApprovalDecision;
  decidedBy: string;
  note: string;
  approvalContext: string | null;
}): unknown[] {
  const verb = outcome.decision === 'approve' ? ':white_check_mark: *Approved*' : ':no_entry: *Denied*';
  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${verb} \`${escapeMrkdwn(outcome.actionPath)}\` — by ${outcome.decidedBy}`,
      },
    },
  ];
  if (outcome.approvalContext) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: clip(`Agent's description: ${escapeMrkdwn(outcome.approvalContext)}`, SECTION_MAX) }],
    });
  }
  if (outcome.note) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Message to the agent*\n${quote(outcome.note)}` },
    });
  }
  return blocks;
}

export interface ApprovalReplyMetadata {
  executionId: string;
  projectId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  responseUrl?: string;
}

function decodeReplyMetadata(raw: string | undefined): ApprovalReplyMetadata | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ApprovalReplyMetadata>;
    if (!parsed.executionId || !parsed.projectId || !parsed.teamId || !parsed.channelId || !parsed.threadTs || !parsed.messageTs) {
      return null;
    }
    return {
      executionId: parsed.executionId,
      projectId: parsed.projectId,
      teamId: parsed.teamId,
      channelId: parsed.channelId,
      threadTs: parsed.threadTs,
      messageTs: parsed.messageTs,
      responseUrl: typeof parsed.responseUrl === 'string' ? parsed.responseUrl : undefined,
    };
  } catch {
    return null;
  }
}

/** "Reply…": a message to the agent plus the decision it goes with. Deny is the
 *  default — a reply is most often "not like this". */
export function buildApprovalReplyView(actionPath: string, metadata: ApprovalReplyMetadata): Record<string, unknown> {
  const deny = { text: { type: 'plain_text', text: 'Deny' }, value: 'deny' };
  const approve = { text: { type: 'plain_text', text: 'Approve' }, value: 'approve' };
  return {
    type: 'modal',
    callback_id: APPROVAL_REPLY_CALLBACK,
    // Slack's metadata is echoed back verbatim; the submit path re-resolves and
    // re-authorizes rather than trusting it.
    private_metadata: JSON.stringify(metadata).slice(0, 3000),
    title: { type: 'plain_text', text: 'Reply to the agent' },
    submit: { type: 'plain_text', text: 'Send' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `\`${escapeMrkdwn(clip(actionPath, 200))}\`` } },
      {
        type: 'input',
        block_id: DECISION_BLOCK,
        label: { type: 'plain_text', text: 'Decision' },
        element: { type: 'radio_buttons', action_id: DECISION_ACTION, initial_option: deny, options: [deny, approve] },
      },
      {
        type: 'input',
        block_id: NOTE_BLOCK,
        label: { type: 'plain_text', text: 'Message to the agent' },
        element: {
          type: 'plain_text_input',
          action_id: NOTE_ACTION,
          multiline: true,
          max_length: 2000,
          placeholder: { type: 'plain_text', text: 'Sent to the agent with your decision' },
        },
      },
    ],
  };
}

type ViewState = { state?: { values?: Record<string, Record<string, { value?: string | null; selected_option?: { value?: string } | null }>> } };

export function readApprovalReply(view: ViewState): { decision: ApprovalDecision; note: string } {
  const values = view?.state?.values ?? {};
  const decision = values[DECISION_BLOCK]?.[DECISION_ACTION]?.selected_option?.value === 'approve' ? 'approve' : 'deny';
  return { decision, note: normalizeApprovalNote(values[NOTE_BLOCK]?.[NOTE_ACTION]?.value) };
}

interface SlackDecisionInput {
  inbound: SlackInbound;
  projectId: string;
  sessionId: string;
  executionId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  slackUserId: string;
  decision: ApprovalDecision;
  note: string;
  respond: (text: string) => Promise<void>;
}

/** Decide through the shared chat path, then resume the session as a Slack
 *  turn so the thread shows the agent picking it up. */
async function applySlackApprovalDecision(input: SlackDecisionInput): Promise<void> {
  const result = await decideChatApproval({
    user: chatUser('slack', input.teamId, input.slackUserId),
    projectId: input.projectId,
    sessionId: input.sessionId,
    executionId: input.executionId,
    decision: input.decision,
    note: input.note,
  });
  if ('refusal' in result) {
    await input.respond(result.refusal);
    return;
  }
  // Resume as an in-thread follow-up from the clicker (same path as a question
  // answer): spawnAgentTurn re-checks their access and streams the agent's
  // response into this thread.
  const event: SlackEvent = {
    type: 'message',
    user: input.slackUserId,
    channel: input.channelId,
    text: approvalResumeText(result.row.actionPath, input.decision, input.note),
    ts: input.messageTs,
    thread_ts: input.threadTs,
    team: input.teamId,
  };
  const envelope: SlackEnvelope = { type: 'event_callback', team_id: input.teamId, event };
  await spawnAgentTurn(input.projectId, envelope, event, { ownThreadsOnly: input.inbound.kind === 'project' });
}

/** A button on an approval card. */
export async function handleApprovalCardAction(
  payload: SlackInteractionPayload,
  parsed: { verb: ApprovalCardVerb; executionId: string },
  inbound: SlackInbound,
): Promise<void> {
  // The "Open in Kortix" link button still fires a block_action; nothing to apply.
  if (parsed.verb === 'view') return;
  const teamId = payload.team?.id ?? '';
  const channelId = payload.channel?.id ?? '';
  const slackUserId = payload.user?.id ?? '';
  const messageTs = payload.message?.ts ?? '';
  const threadTs = payload.message?.thread_ts ?? messageTs;
  if (!teamId || !channelId || !slackUserId || !threadTs) return;
  const respond = (text: string) => respondViaUrl(payload.response_url, { response_type: 'ephemeral', text });

  const thread = await findSlackThread(inbound, teamId, threadTs);
  if (!thread) {
    await respond('That approval is no longer available.');
    return;
  }

  if (parsed.verb === 'reply') {
    // `trigger_id` expires in ~3 seconds, so open the modal before any lookup;
    // the submit path resolves and authorizes from scratch.
    const token = payload.trigger_id ? await loadSlackTokenForProject(thread.projectId) : null;
    const row = token ? await loadApprovalRow(thread.projectId, parsed.executionId) : null;
    const opened =
      token && row && payload.trigger_id
        ? await openModal(
            token,
            payload.trigger_id,
            buildApprovalReplyView(row.actionPath, {
              executionId: parsed.executionId,
              projectId: thread.projectId,
              teamId,
              channelId,
              threadTs,
              messageTs,
              responseUrl: payload.response_url,
            }),
          )
        : false;
    if (!opened) await respond("Couldn't open the reply box. Use *Open in Kortix* to answer there.");
    return;
  }

  await applySlackApprovalDecision({
    inbound,
    projectId: thread.projectId,
    sessionId: thread.sessionId,
    executionId: parsed.executionId,
    teamId,
    channelId,
    threadTs,
    messageTs,
    slackUserId,
    decision: parsed.verb,
    note: '',
    respond,
  });
}

/** The "Reply…" modal came back — a separate signed request, re-authorized here. */
export async function handleApprovalReplySubmission(
  payload: SlackInteractionPayload,
  inbound: SlackInbound,
): Promise<void> {
  const meta = decodeReplyMetadata(payload.view?.private_metadata);
  const slackUserId = payload.user?.id ?? '';
  if (!meta || !slackUserId) return;
  if (!inboundAllowsProject(inbound, meta.projectId) || !inboundAllowsTeam(inbound, meta.teamId)) return;
  const respond = async (text: string) => {
    if (meta.responseUrl) await respondViaUrl(meta.responseUrl, { response_type: 'ephemeral', text });
  };
  const thread = await findSlackThread(inbound, meta.teamId, meta.threadTs);
  if (!thread || thread.projectId !== meta.projectId) {
    await respond('That approval is no longer available.');
    return;
  }
  const { decision, note } = readApprovalReply(payload.view ?? {});
  await applySlackApprovalDecision({
    inbound,
    projectId: thread.projectId,
    sessionId: thread.sessionId,
    executionId: meta.executionId,
    teamId: meta.teamId,
    channelId: meta.channelId,
    threadTs: meta.threadTs,
    messageTs: meta.messageTs,
    slackUserId,
    decision,
    note,
    respond,
  });
}
