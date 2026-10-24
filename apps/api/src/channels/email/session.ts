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
import {
  deliverThroughQueue,
  createSession as createLifecycleSession,
  resolveProjectAutomationActor as resolveLifecycleAutomationActor,
} from '../../projects/session-lifecycle';
import { db } from '../../shared/db';
import {
  RESEND_INBOX_EMAIL_RECEIVED,
  getResendThreadEmail,
  replyToResendThreadEmail,
  resolveEmailApiKey,
} from '../resend-email-api';
import { dropChatThread, findChatThread, touchChatThread } from '../core/threads';
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

const defaultEmailSessionLifecycle = {
  deliverFollowUp: deliverThroughQueue,
  createSession: createLifecycleSession,
  resolveProjectAutomationActor: resolveLifecycleAutomationActor,
};

let emailSessionLifecycle = defaultEmailSessionLifecycle;
let emailSenderPolicyLoader = emailSenderPolicyForInbox;

export function setEmailSessionLifecycleForTest(
  overrides: Partial<typeof defaultEmailSessionLifecycle>,
) {
  emailSessionLifecycle = { ...defaultEmailSessionLifecycle, ...overrides };
}

export function resetEmailSessionLifecycleForTest() {
  emailSessionLifecycle = defaultEmailSessionLifecycle;
  emailSenderPolicyLoader = emailSenderPolicyForInbox;
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

async function spawnEmailAgentTurn(
  projectId: string,
  email: InboundEmail,
): Promise<void> {
  const inboxId = email.inboxId;
  const threadId = email.threadId;
  if (!inboxId || !threadId) return;

  const thread = { platform: 'email', workspaceId: inboxId, threadId };
  const existing = await findChatThread(thread);

  if (existing) {
    if (
      !(await ensureEmailSessionBinding({
        projectId,
        sessionId: existing.sessionId,
        inboxId,
      }))
    ) {
      console.error('[email-webhook] could not bind existing session to inbox connection', {
        projectId,
        sessionId: existing.sessionId,
        inboxId,
      });
      return;
    }
    const outcome = await emailSessionLifecycle.deliverFollowUp({
      source: 'email',
      idempotencyKey: emailFollowUpKey(email),
      sessionId: existing.sessionId,
      text: renderFollowUpPrompt(email),
    });
    if (outcome === 'delivered' || outcome === 'queued') {
      await touchChatThread(thread);
    } else if (outcome === 'no-session') {
      await dropChatThread(thread);
      await createThreadSession(projectId, email, true);
    }
    return;
  }

  await createThreadSession(projectId, email, false);
}

/** One received email: a redelivered webhook dedupes on it. */
function emailFollowUpKey(email: InboundEmail): string {
  return `email:${email.inboxId}:${email.emailId}`;
}

async function createThreadSession(
  projectId: string,
  email: InboundEmail,
  revived: boolean,
): Promise<void> {
  const inboxId = email.inboxId;
  const threadId = email.threadId;
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!project) return;

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
    console.error('[email-webhook] no active inbox account', { projectId, inboxId });
    return;
  }
  const privateInbox = account.ownerType === 'member' && Boolean(account.ownerId);
  const userId = privateInbox
    ? account.ownerId!
    : await emailSessionLifecycle.resolveProjectAutomationActor(project.accountId);
  if (!userId) {
    console.warn('[email-webhook] no actor for project', projectId);
    return;
  }

  const claimKey = `email:threadcreate:${inboxId}:${threadId}`;
  if (!(await claimThreadCreate(claimKey))) {
    const sessionId = await waitForThreadSession(inboxId, threadId);
    if (sessionId) {
      if (!(await ensureEmailSessionBinding({ projectId, sessionId, inboxId }))) {
        console.error('[email-webhook] could not bind claimed session to inbox connection', {
          projectId,
          sessionId,
          inboxId,
        });
        return;
      }
      await emailSessionLifecycle.deliverFollowUp({
        source: 'email',
        idempotencyKey: emailFollowUpKey(email),
        sessionId,
        text: renderFollowUpPrompt(email),
      });
    }
    return;
  }

  const initialPrompt = renderAgentPrompt(email, revived);
  const emailConnectionId = account.connectionId;
  const result = await emailSessionLifecycle.createSession({
    source: 'email',
    project,
    userId,
    requestingPrincipalType: 'human',
    body: {
      base_ref: project.defaultBranch,
      agent_name: selection?.agentName || 'default',
      ...(selection?.opencodeModel ? { opencode_model: selection.opencodeModel } : {}),
      connector_bindings: {
        email: { connection_id: emailConnectionId },
      },
      // Email delivers its prompt via postCreate, so create is the only moment
      // this session has any user text — title from the subject.
      title_source: messageSubject(email) ?? messageSummary(email),
    },
    mayManageSystemConnections: true,
    queuePolicy: 'on_backpressure',
    // One key per message, never per thread: the lifecycle keeps a key
    // forever, so under the thread's key a failed first start (dead-lettered)
    // answered every later reply in the thread with the same failure, and a
    // deleted session answered 409 IDEMPOTENCY_KEY_SESSION_DELETED. Racing
    // messages are serialized by the thread-create claim above.
    idempotencyKey: email.emailId
      ? `email:create:${inboxId}:${threadId}:${email.emailId}`
      : claimKey,
    postCreate: [
      {
        type: 'bind_chat_thread',
        platform: 'email',
        workspaceId: inboxId,
        threadId,
      },
      {
        type: 'deliver_prompt',
        source: 'email',
        text: initialPrompt,
        userId,
      },
    ],
    visibility: privateInbox ? 'private' : 'project',
    metadata: {
      source: 'email',
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
  });

  if (result.error) {
    console.error('[email-webhook] createProjectSession failed', {
      status: result.error.status,
      body: result.error.body,
    });
    if (result.error.body.code === 'project_archived') await replyNotAccepting(projectId, email);
  }
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

async function claimThreadCreate(key: string): Promise<boolean> {
  try {
    const inserted = await db
      .insert(chatEventDedup)
      .values({
        eventId: key,
        expiresAt: new Date(Date.now() + EMAIL_EVENT_DEDUPE_TTL_MS),
      })
      .onConflictDoNothing({ target: chatEventDedup.eventId })
      .returning({ eventId: chatEventDedup.eventId });
    return inserted.length > 0;
  } catch (err) {
    console.warn('[email-webhook] thread-create claim failed (fail-open)', err);
    return true;
  }
}

async function waitForThreadSession(inboxId: string, threadId: string): Promise<string | null> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const row = await findChatThread({ platform: 'email', workspaceId: inboxId, threadId });
    if (row) return row.sessionId;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
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
