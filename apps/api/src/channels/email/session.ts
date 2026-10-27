import {
  chatChannelBindings,
  chatEventDedup,
  chatInstalls,
  projects,
} from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { config } from '../../config';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { type IntegrationEvent, registerEventConsumer } from '../../integrations/event-inbox';
import { logger } from '../../lib/logger';
import { ensureEmailSessionBinding } from '../../projects/lib/session-connector-bindings';
import { db } from '../../shared/db';
import {
  RESEND_INBOX_EMAIL_RECEIVED,
  getResendThreadEmail,
  replyToResendThreadEmail,
  resolveEmailApiKey,
} from '../resend-email-api';
import { type ChannelPort, type ChannelSessionPlan, type ChannelTarget, routeChannelMessage } from '../core/conversation';
import {
  type EmailSenderPolicy,
  emailOwnKeyForAccount,
  emailOwnKeyForInbox,
  loadEmailInboxAccountForInbox,
} from '../install-store';
import { matchesEmailSenderRegex } from './sender-policy-regex';
import type { InboundEmail, ResendInboxEmailReceivedEvent } from './types';

export function resetEmailChannelForTest() {
  threadEmailLoader = getResendThreadEmail;
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

export const EMAIL_MESSAGE_EVENT = 'email.message.received';

/** `IntegrationEvent.data` of a received email: the webhook's ids and headers, never a body. */
interface EmailEventData {
  inbox_id: string;
  thread_id: string;
  email_id: string;
  from: string;
  to: string[];
  subject: string | null;
}

/**
 * The event-inbox envelope of a received email, or null when the Resend event
 * is not one. The event names the email but carries no body; the consumer
 * reads the body from Resend.
 */
export function emailMessageEvent(projectId: string, event: ResendInboxEmailReceivedEvent): IntegrationEvent | null {
  if (event.type !== RESEND_INBOX_EMAIL_RECEIVED) return null;
  const { inbox_id, thread_id, email_id, from, to, subject } = event.data;
  if (!inbox_id || !thread_id || !email_id) return null;
  const data: EmailEventData = { inbox_id, thread_id, email_id, from: from ?? '', to: to ?? [], subject: subject ?? null };
  return {
    id: email_id,
    source: `email:${inbox_id}`,
    type: EMAIL_MESSAGE_EVENT,
    time: event.created_at ?? new Date().toISOString(),
    subject: thread_id,
    projectId,
    data: data as unknown as Record<string, unknown>,
  };
}

/**
 * One stored received email, in the project that held its inbox at the ack.
 * The route checked the sender policy before the store; the email runs only
 * while that project still has the channel, the inbox and the sender allowed.
 * A throw retries the email (8 attempts over about 20 min).
 */
export async function handleEmailEvent(event: IntegrationEvent, run: { finalAttempt: boolean }): Promise<void> {
  const { inbox_id: inboxId, thread_id: threadId, email_id: emailId, from, to, subject } =
    event.data as unknown as EmailEventData;
  const { projectId } = event;
  if (!(await emailChannelOnForProject(projectId))) {
    logger.info('[email-webhook] email channel turned off since the email arrived; dropped', { projectId, inboxId, emailId });
    return;
  }
  const account = await loadEmailInboxAccountForInbox(projectId, inboxId);
  if (!account) {
    logger.info('[email-webhook] inbox removed from the project since the email arrived; dropped', { projectId, inboxId, emailId });
    return;
  }
  if (!isEmailSenderAllowed(from, account.senderPolicy)) {
    logger.warn('[email-webhook] sender rejected by inbox policy', { inboxId, emailId, sender: from });
    return;
  }
  const apiKey = resolveEmailApiKey(await emailOwnKeyForAccount(account));
  if (!apiKey) {
    logger.error('[email-webhook] no Resend key for inbox', { projectId, inboxId });
    return;
  }
  const full = await threadEmailLoader({ apiKey, inboxId, threadId, emailId });
  const email: InboundEmail = {
    inboxId,
    threadId,
    emailId,
    from: full.from || from,
    to: full.to ?? to,
    subject: full.subject ?? subject,
    text: full.text || stripHtml(full.html) || '',
    attachments: (full.attachments ?? []).map((a) => ({
      id: a.id,
      filename: a.filename ?? null,
      size: a.size ?? null,
    })),
  };
  await routeChannelMessage(
    emailPort,
    {
      target: { platform: 'email', workspaceId: inboxId, threadId, projectId, messageId: emailId },
      // One lifecycle key per message, never per thread: the lifecycle keeps a
      // key forever, so under the thread's key a failed first start (dead-lettered)
      // answered every later reply in the thread with the same failure.
      keys: {
        followUp: `email:${inboxId}:${emailId}`,
        create: `email:create:${inboxId}:${threadId}:${emailId}`,
        createClaim: `email:threadcreate:${inboxId}:${threadId}`,
      },
      followUp: { text: renderFollowUpPrompt(email) },
      plan: (revived) => planEmailSession(projectId, email, revived),
    },
    run,
  );
}

// A cold start can take ~405 s (a 15 s body read, a 90 s clone, a 300 s
// first-prompt wait): the visibility outlasts it. Two per replica, so mail
// never takes every job slot.
registerEventConsumer('email.', handleEmailEvent, { visibilityMs: 7 * 60_000, batch: 2 });

/**
 * A readable body for an HTML-only email. Linear in the input: a sender
 * controls it, and a quadratic pattern stalled the API on crafted HTML (a run
 * of `<script` or `<` took seconds).
 */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return dropScriptsAndStyles(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^<>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Drop every `<script>` and `<style>` block; an unclosed one stays as text. */
function dropScriptsAndStyles(html: string): string {
  const opener = /<(script|style)\b/gi;
  const closers = { script: /<\/script/gi, style: /<\/style/gi };
  let out = '';
  let pos = 0;
  for (let open = opener.exec(html); open; open = opener.exec(html)) {
    const closer = closers[open[1]!.toLowerCase() as keyof typeof closers];
    closer.lastIndex = open.index;
    const close = closer.exec(html);
    const end = close ? html.indexOf('>', close.index) : -1;
    if (end < 0) break;
    out += html.slice(pos, open.index);
    pos = end + 1;
    opener.lastIndex = pos;
  }
  return out + html.slice(pos);
}

/**
 * Email on the conversation core: a Resend thread is the conversation. A sender
 * outside the workspace gets no status mail, because a reply invites backscatter
 * and auto-responder loops; the one exception is the archived project's notice.
 */
const emailPort: ChannelPort = {
  async notify(target, notice) {
    if (notice.kind === 'create_failed' && notice.error.body.code === 'project_archived') await replyNotAccepting(target);
  },
  async prepareFollowUp(target, thread) {
    if (await ensureEmailSessionBinding({ projectId: target.projectId, sessionId: thread.sessionId, inboxId: target.workspaceId })) {
      return true;
    }
    logger.warn('[email-webhook] could not bind the thread session to the inbox connection; email dropped', {
      projectId: target.projectId,
      sessionId: thread.sessionId,
      inboxId: target.workspaceId,
    });
    return false;
  },
};

/**
 * The session an email thread starts. The inbox's binding picks the agent and
 * model, a private inbox ("only me") runs as its owner, and the session is
 * pinned to the inbox's connector account.
 */
async function planEmailSession(projectId: string, email: InboundEmail, revived: boolean): Promise<ChannelSessionPlan | null> {
  const { inboxId, threadId } = email;
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!project) return null;

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
        eq(chatChannelBindings.projectId, projectId),
        eq(chatChannelBindings.platform, 'email'),
        eq(chatChannelBindings.workspaceId, inboxId),
      ),
    )
    .limit(1);

  // A private inbox ("only me") is its owner's account: its mail starts a
  // private session as that person, the only session that may use it. A
  // shared inbox runs as the project's automation actor, visible to the project.
  const account = await loadEmailInboxAccountForInbox(projectId, inboxId);
  if (!account) {
    logger.error('[email-webhook] no active inbox account', { projectId, inboxId });
    return null;
  }
  const privateInbox = account.ownerType === 'member' && Boolean(account.ownerId);
  return {
    project,
    ...(privateInbox ? { userId: account.ownerId! } : {}),
    visibility: privateInbox ? 'private' : 'project',
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
    prompt: renderAgentPrompt(email, revived),
  };
}

// A deleted workspace keeps its inbox until the purge, so mail still arrives
// and no session can start (KRTX-1714). Tell the sender, in words that fit a
// sender outside the workspace. Once per thread for 30 days, so an
// auto-responder cannot loop; fail closed (no claim, no reply). An
// `.unauthenticated` message gets nothing: its From may be forged.
const NOT_ACCEPTING_NOTICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const NOT_ACCEPTING_REPLY =
  'This address is not accepting email right now. No one will answer this message.';

async function replyNotAccepting(target: ChannelTarget): Promise<void> {
  const { projectId, workspaceId: inboxId, threadId, messageId: emailId } = target;
  // A session-addressed target carries no email to answer (Email is not in session-notice.ts).
  if (!emailId) return;
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
