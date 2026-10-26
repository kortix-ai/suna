import {
  chatChannelBindings,
  chatEventDedup,
  chatInstalls,
  projects,
} from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { config } from '../../config';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { logger } from '../../lib/logger';
import { ensureEmailSessionBinding } from '../../projects/lib/session-connector-bindings';
import { db } from '../../shared/db';
import {
  RESEND_INBOX_EMAIL_RECEIVED,
  getResendThreadEmail,
  replyToResendThreadEmail,
  resolveEmailApiKey,
} from '../resend-email-api';
import { type ChannelMessage, type ChannelPort, routeChannelMessage } from '../core/conversation';
import {
  type EmailSenderPolicy,
  emailOwnKeyForInbox,
  emailSenderPolicyForInbox,
  loadEmailInboxAccountForInbox,
} from '../install-store';
import { EMAIL_EVENT_DEDUPE_TTL_MS } from './app';
import { recordClaim } from '../webhook-work';
import { matchesEmailSenderRegex } from './sender-policy-regex';
import type { InboundEmail, ResendInboxEmailReceivedEvent } from './types';

let emailSenderPolicyLoader = emailSenderPolicyForInbox;

export function resetEmailLoadersForTest() {
  emailSenderPolicyLoader = emailSenderPolicyForInbox;
  threadEmailLoader = getResendThreadEmail;
}

export function setEmailSenderPolicyLoaderForTest(
  loader: typeof emailSenderPolicyForInbox,
) {
  emailSenderPolicyLoader = loader;
}

export async function resolveProjectForEmailInbox(inboxId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'email'), eq(chatInstalls.workspaceId, inboxId)))
    .limit(1);
  return row?.projectId ?? null;
}

/** Whether the project has the email channel (`email_channel`); off, its inboxes' mail is ignored. */
export async function emailChannelOnForProject(projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  return Boolean(row) && resolveFeatureFlag(row!.metadata, 'email_channel');
}

let threadEmailLoader = getResendThreadEmail;

export function setThreadEmailLoaderForTest(loader: typeof getResendThreadEmail) {
  threadEmailLoader = loader;
}

/**
 * One received inbox email. The event names it (inbox, thread, email) but
 * carries no body, so the body is read from Resend once the sender passed the
 * inbox's policy. An inbox this environment does not know is ignored: dev,
 * staging and prod share Kortix's Resend team and its team-wide webhooks.
 */
export async function dispatchResendEmailEvent(event: ResendInboxEmailReceivedEvent): Promise<void> {
  if (event.type !== RESEND_INBOX_EMAIL_RECEIVED) return;
  const { inbox_id: inboxId, thread_id: threadId, email_id: emailId } = event.data;
  if (!inboxId || !threadId || !emailId) return;
  if (await alreadyHandled(`email:event:${emailId}`)) return;
  const projectId = await resolveProjectForEmailInbox(inboxId);
  if (!projectId) return;
  const policy = await emailSenderPolicyLoader(projectId, inboxId);
  const sender = event.data.from ?? '';
  if (!isEmailSenderAllowed(sender, policy)) {
    console.warn('[email-webhook] sender rejected by inbox policy', { inboxId, emailId, sender });
    return;
  }
  if (!(await claimInboundMessage(inboxId, emailId))) return;
  const apiKey = resolveEmailApiKey(await emailOwnKeyForInbox(projectId, inboxId));
  if (!apiKey) {
    console.error('[email-webhook] no Resend key for inbox', { projectId, inboxId });
    return;
  }
  const full = await threadEmailLoader({ apiKey, inboxId, threadId, emailId });
  await spawnEmailAgentTurn(projectId, {
    inboxId,
    threadId,
    emailId,
    from: full.from || sender,
    to: full.to ?? event.data.to ?? [],
    subject: full.subject ?? event.data.subject ?? null,
    text: full.text || stripHtml(full.html) || '',
    attachments: (full.attachments ?? []).map((a) => ({
      id: a.id,
      filename: a.filename ?? null,
      size: a.size ?? null,
    })),
  });
}

/** A readable body for an HTML-only email. */
function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface EmailChannelMessage extends ChannelMessage {
  email: InboundEmail;
}

/**
 * Email on the conversation core: a Resend thread is the conversation. The
 * inbox's binding picks the agent and model, a private inbox ("only me") runs
 * as its owner, and the session is pinned to the inbox's connector account.
 */
const emailPort: ChannelPort<EmailChannelMessage> = {
  source: 'email',
  prompt: ({ email }, kind) => (kind === 'follow-up' ? renderFollowUpPrompt(email) : renderAgentPrompt(email, kind === 'revived')),
  beforeFollowUp: async ({ projectId, email }, sessionId) => {
    const bound = await ensureEmailSessionBinding({ projectId, sessionId, inboxId: email.inboxId });
    if (!bound) {
      logger.error('[email-webhook] could not bind the thread session to the inbox connection', {
        projectId,
        sessionId,
        inboxId: email.inboxId,
      });
    }
    return bound;
  },
  planCreate: async ({ email }, project) => {
    const { inboxId, threadId } = email;
    // An email inbox is a first-class channel. Its binding selects the
    // concrete project agent exactly like Slack and Teams bindings do. Older
    // installs have no binding row and fall through to the project default.
    const [selection] = await db
      .select({
        agentName: chatChannelBindings.agentName,
        opencodeModel: chatChannelBindings.model,
      })
      .from(chatChannelBindings)
      .where(
        and(
          eq(chatChannelBindings.projectId, project.projectId),
          eq(chatChannelBindings.platform, 'email'),
          eq(chatChannelBindings.workspaceId, inboxId),
        ),
      )
      .limit(1);

    // A private inbox ("only me") is its owner's account: its mail starts a
    // private session as that person, the only session that may use it. A
    // shared inbox runs as the project's automation actor, visible to the project.
    const account = await loadEmailInboxAccountForInbox(project.projectId, inboxId);
    if (!account) {
      logger.error('[email-webhook] no active inbox account', { projectId: project.projectId, inboxId });
      return null;
    }
    const privateInbox = account.ownerType === 'member' && Boolean(account.ownerId);
    return {
      ...(privateInbox ? { userId: account.ownerId! } : {}),
      body: {
        agent_name: selection?.agentName || 'default',
        ...(selection?.opencodeModel ? { opencode_model: selection.opencodeModel } : {}),
        connector_bindings: {
          email: { connection_id: account.connectionId },
        },
        // Email delivers its prompt via postCreate, so create is the only moment
        // this session has any user text — title from the subject.
        title_source: messageSubject(email) ?? messageSummary(email),
      },
      mayManageSystemConnections: true,
      visibility: privateInbox ? 'private' : 'project',
      metadata: {
        email: {
          inbox_id: inboxId,
          thread_id: threadId,
          message_id: email.emailId,
          address: email.to[0] ?? '',
          from: messageSender(email),
          subject: messageSubject(email),
        },
      },
      extraEnvVars: {
        KORTIX_EMAIL_INBOX_ID: inboxId,
        KORTIX_EMAIL_THREAD_ID: threadId,
        KORTIX_EMAIL_MESSAGE_ID: email.emailId,
        KORTIX_EMAIL_ADDRESS: email.to[0] ?? '',
        KORTIX_FRONTEND_URL: config.FRONTEND_URL,
      },
    };
  },
  // A sender outside the workspace gets no status mail: a reply would invite
  // backscatter and auto-responder loops. The one exception is the archived
  // project's "not accepting" notice, once per thread.
  notify: async ({ projectId, email }, notice) => {
    if (notice.kind === 'create_failed' && notice.error.body.code === 'project_archived') {
      await replyNotAccepting(projectId, email);
      return;
    }
    logger.warn('[email-webhook] message not delivered', { projectId, inboxId: email.inboxId, notice: notice.kind });
  },
};

async function spawnEmailAgentTurn(projectId: string, email: InboundEmail): Promise<void> {
  const { inboxId, threadId, emailId } = email;
  if (!inboxId || !threadId) return;
  // Resend does not retry a webhook the route already acked (channels/webhook-work.ts),
  // so every attempt is the last one.
  await routeChannelMessage(
    emailPort,
    {
      thread: { platform: 'email', workspaceId: inboxId, threadId },
      projectId,
      // One lifecycle key per message, never per thread: the lifecycle keeps a
      // key forever, so under the thread's key a failed first start (dead-lettered)
      // answered every later reply in the thread with the same failure.
      keys: {
        followUp: `email:${inboxId}:${emailId}`,
        create: `email:create:${inboxId}:${threadId}:${emailId}`,
        claim: `email:threadcreate:${inboxId}:${threadId}`,
      },
      email,
    },
    { finalAttempt: true },
  );
}

// A deleted workspace keeps its inbox until the purge, so mail still arrives
// and no session can start (KRTX-1714). Tell the sender, in words that fit a
// sender outside the workspace. Once per thread for 30 days, so an
// auto-responder cannot loop; fail closed (no claim, no reply). An
// `.unauthenticated` message gets nothing: its From may be forged.
const NOT_ACCEPTING_NOTICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const NOT_ACCEPTING_REPLY =
  'This address is not accepting email right now. No one will answer this message.';

async function replyNotAccepting(projectId: string, email: InboundEmail): Promise<void> {
  const { inboxId, threadId, emailId } = email;
  try {
    const claimed = await db
      .insert(chatEventDedup)
      .values({
        eventId: `email:not-accepting:${inboxId}:${threadId}`,
        expiresAt: new Date(Date.now() + NOT_ACCEPTING_NOTICE_TTL_MS),
      })
      .onConflictDoNothing({ target: chatEventDedup.eventId })
      .returning({ eventId: chatEventDedup.eventId });
    if (claimed.length === 0) return;
    const apiKey = resolveEmailApiKey(await emailOwnKeyForInbox(projectId, inboxId));
    if (!apiKey) return;
    await replyToResendThreadEmail({ apiKey, inboxId, threadId, emailId, text: NOT_ACCEPTING_REPLY });
  } catch (err) {
    logger.warn('[email-webhook] not-accepting reply failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function alreadyHandled(key: string): Promise<boolean> {
  try {
    const inserted = await db
      .insert(chatEventDedup)
      .values({
        eventId: key,
        expiresAt: new Date(Date.now() + EMAIL_EVENT_DEDUPE_TTL_MS),
      })
      .onConflictDoNothing({ target: chatEventDedup.eventId })
      .returning({ eventId: chatEventDedup.eventId });
    if (inserted.length > 0) recordClaim(key);
    return inserted.length === 0;
  } catch (err) {
    console.warn('[email-webhook] event dedup check failed', err);
    return false;
  }
}

async function claimInboundMessage(inboxId: string, emailId: string): Promise<boolean> {
  const key = `email:msg:${inboxId}:${emailId}`;
  try {
    const inserted = await db
      .insert(chatEventDedup)
      .values({
        eventId: key,
        expiresAt: new Date(Date.now() + EMAIL_EVENT_DEDUPE_TTL_MS),
      })
      .onConflictDoNothing({ target: chatEventDedup.eventId })
      .returning({ eventId: chatEventDedup.eventId });
    if (inserted.length > 0) recordClaim(key);
    return inserted.length > 0;
  } catch (err) {
    console.error('[email-webhook] inbound message claim failed (fail-open)', err);
    return true;
  }
}

/**
 * How the agent works the inbox: the `kortix connectors` CLI, which every
 * harness's shell has. The MCP face exists only in OpenCode's config, so a
 * prompt that named MCP tools left a pi session unable to read or answer.
 */
function emailTurnInstructions(email: InboundEmail): string {
  const readThreadArgs = JSON.stringify({ thread_id: email.threadId });
  const replyArgs = JSON.stringify({
    thread_id: email.threadId,
    message_id: email.emailId,
    text: '<reply>',
  });
  return [
    'How to work:',
    '- You are operating an email inbox assigned to this Kortix project.',
    '- Use the `kortix connectors` CLI in the shell. Connector actions are not direct tools.',
    `- Read the current thread, every email with its body: \`kortix connectors call email.get_thread '${readThreadArgs}'\`.`,
    `- Reply in the same conversation: \`kortix connectors call email.reply_message '${replyArgs}'\`. Use \`html\` instead of \`text\` only when needed.`,
    '- Start a new outbound email with `kortix connectors call email.send_message` and args containing `to`, `subject`, and `text` or `html`.',
    '- Run `kortix connectors show email.<action>` to confirm an input schema before the first call. Pass long or quoted args as a file: `@args.json`.',
    '- Kortix fills in the inbox and resolves the email key server-side. Do not look for either in the sandbox.',
    '- If you need the user to clarify something, reply by email and end the turn. Their next reply will resume this same session.',
  ].join('\n');
}

function renderFollowUpPrompt(email: InboundEmail): string {
  return [
    `New email reply from ${messageSender(email)} in the same thread:`,
    '',
    messageSummary(email),
    '',
    emailTurnInstructions(email),
  ].join('\n');
}

function renderAgentPrompt(email: InboundEmail, revived: boolean): string {
  const lines: string[] = [];
  if (revived) {
    lines.push(
      'NOTE: This email thread had an earlier conversation, but that session was deleted.',
      'Pick the thread back up from the current email context.',
      '',
    );
  }
  lines.push(
    "You're answering an email thread as the Kortix agent.",
    '',
    `Inbox ID:   ${email.inboxId}`,
    `Thread ID:  ${email.threadId}`,
    `Message ID: ${email.emailId}`,
    `From:       ${messageSender(email)}`,
    `To:         ${email.to.join(', ')}`,
    `Subject:    ${messageSubject(email) ?? '(no subject)'}`,
    '',
    messageSummary(email),
    '',
    emailTurnInstructions(email),
  );
  return lines.join('\n');
}

function messageSubject(email: InboundEmail): string | null {
  return email.subject;
}

function messageSummary(email: InboundEmail): string {
  const attachments = email.attachments.length
    ? [
        '',
        'Attachments:',
        ...email.attachments.map(
          (a) => `- ${a.filename ?? a.id} (${a.size ?? 'unknown'} bytes, attachment_id ${a.id})`,
        ),
      ].join('\n')
    : '';
  return ['Email body:', email.text || '(empty)', attachments].filter(Boolean).join('\n');
}

function messageSender(email: InboundEmail): string {
  return email.from.trim();
}

const MAILBOX_PATTERN = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

/**
 * The one canonical mailbox in a From value.
 *
 * A substring match is not an authorization boundary: a crafted value such
 * as `allowed@example.com <attacker@evil.test>` contains an allowlisted
 * address even though the actual mailbox is the value in angle brackets.
 * Accept either a bare address or one ordinary `Display Name <address>`
 * mailbox, and reject ambiguous/multi-address values entirely.
 */
export function canonicalMailbox(value: string): string | null {
  const sender = value.trim().toLowerCase();
  const matches = [...sender.matchAll(MAILBOX_PATTERN)];
  if (matches.length !== 1) return null;
  const mailbox = matches[0]?.[0];
  if (!mailbox) return null;
  if (sender === mailbox) return mailbox;

  const open = sender.indexOf('<');
  const close = sender.indexOf('>');
  if (
    open <= 0 ||
    close !== sender.length - 1 ||
    sender.indexOf('<', open + 1) !== -1 ||
    sender.indexOf('>', close + 1) !== -1 ||
    sender.slice(open + 1, close).trim() !== mailbox
  ) {
    return null;
  }
  return mailbox;
}

/** Whether the inbox's sender policy lets `from` start or continue a session. */
export function isEmailSenderAllowed(from: string, policy: EmailSenderPolicy): boolean {
  if (policy.mode !== 'restricted') return true;
  const email = canonicalMailbox(from);
  if (!email) return false;
  if (policy.allowedEmails.includes(email)) return true;
  const domain = email.split('@')[1] ?? '';
  if (
    policy.allowedDomains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`))
  ) {
    return true;
  }
  if (policy.allowedRegex) {
    return matchesEmailSenderRegex(policy.allowedRegex, email);
  }
  return false;
}
