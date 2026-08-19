import {
  chatChannelBindings,
  chatEventDedup,
  chatInstalls,
  chatThreads,
  projects,
} from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { config } from '../../config';
import {
  ensureEmailSessionBinding,
  loadEmailInstallConnectionId,
} from '../../projects/lib/session-connector-bindings';
import {
  continueSession as continueLifecycleSession,
  createSession as createLifecycleSession,
  resolveProjectAutomationActor as resolveLifecycleAutomationActor,
} from '../../projects/session-lifecycle';
import { db } from '../../shared/db';
import { type AgentMailSenderPolicy, loadAgentMailSenderPolicyForInbox } from '../install-store';
import { EMAIL_EVENT_DEDUPE_TTL_MS } from './app';
import { matchesEmailSenderRegex } from './sender-policy-regex';
import type { AgentMailMessageReceivedEvent } from './types';

const defaultEmailSessionLifecycle = {
  continueSession: continueLifecycleSession,
  createSession: createLifecycleSession,
  resolveProjectAutomationActor: resolveLifecycleAutomationActor,
};

let emailSessionLifecycle = defaultEmailSessionLifecycle;
let emailSenderPolicyLoader = loadAgentMailSenderPolicyForInbox;

export function setEmailSessionLifecycleForTest(
  overrides: Partial<typeof defaultEmailSessionLifecycle>,
) {
  emailSessionLifecycle = { ...defaultEmailSessionLifecycle, ...overrides };
}

export function resetEmailSessionLifecycleForTest() {
  emailSessionLifecycle = defaultEmailSessionLifecycle;
  emailSenderPolicyLoader = loadAgentMailSenderPolicyForInbox;
}

export function setEmailSenderPolicyLoaderForTest(
  loader: typeof loadAgentMailSenderPolicyForInbox,
) {
  emailSenderPolicyLoader = loader;
}

export async function resolveProjectForAgentMailInbox(inboxId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'email'), eq(chatInstalls.workspaceId, inboxId)))
    .limit(1);
  return row?.projectId ?? null;
}

export async function dispatchAgentMailEvent(event: AgentMailMessageReceivedEvent): Promise<void> {
  if (!isInboundMessageEvent(event.event_type)) return;
  if (await alreadyHandled(`email:event:${event.event_id}`)) return;
  const projectId = await resolveProjectForAgentMailInbox(event.message.inbox_id);
  if (!projectId) {
    console.warn('[email-webhook] no project install for AgentMail inbox', {
      inboxId: event.message.inbox_id,
      eventId: event.event_id,
    });
    return;
  }
  const policy = await emailSenderPolicyLoader(projectId, event.message.inbox_id);
  if (!senderAllowed(event, policy)) {
    console.warn('[email-webhook] sender rejected by AgentMail inbox policy', {
      inboxId: event.message.inbox_id,
      eventId: event.event_id,
      sender: messageSender(event),
    });
    return;
  }
  if (!(await claimInboundMessage(event))) return;
  await spawnEmailAgentTurn(projectId, event);
}

async function spawnEmailAgentTurn(
  projectId: string,
  event: AgentMailMessageReceivedEvent,
): Promise<void> {
  const inboxId = event.message.inbox_id;
  const threadId = event.message.thread_id;
  if (!inboxId || !threadId) return;

  const [existing] = await db
    .select({ sessionId: chatThreads.sessionId })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.platform, 'email'),
        eq(chatThreads.workspaceId, inboxId),
        eq(chatThreads.threadId, threadId),
      ),
    )
    .limit(1);

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
    const outcome = await emailSessionLifecycle.continueSession({
      source: 'email',
      sessionId: existing.sessionId,
      text: renderFollowUpPrompt(event),
      opencodeEnv: { KORTIX_CONNECTORS_MCP_ENABLED: '1' },
    });
    if (outcome === 'delivered') {
      await db
        .update(chatThreads)
        .set({ lastMessageAt: new Date() })
        .where(
          and(
            eq(chatThreads.platform, 'email'),
            eq(chatThreads.workspaceId, inboxId),
            eq(chatThreads.threadId, threadId),
          ),
        );
    } else if (outcome === 'no-session') {
      await db
        .delete(chatThreads)
        .where(
          and(
            eq(chatThreads.platform, 'email'),
            eq(chatThreads.workspaceId, inboxId),
            eq(chatThreads.threadId, threadId),
          ),
        );
      await createThreadSession(projectId, event, true);
    }
    return;
  }

  await createThreadSession(projectId, event, false);
}

async function createThreadSession(
  projectId: string,
  event: AgentMailMessageReceivedEvent,
  revived: boolean,
): Promise<void> {
  const inboxId = event.message.inbox_id;
  const threadId = event.message.thread_id;
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!project) return;

  // An AgentMail inbox is a first-class channel. Its binding selects the
  // concrete project agent exactly like Slack and Teams bindings do. Older
  // installs have no binding row and fall through to the project default.
  const [selection] = await db
    .select({
      agentName: chatChannelBindings.agentName,
      opencodeModel: chatChannelBindings.opencodeModel,
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

  const userId = await emailSessionLifecycle.resolveProjectAutomationActor(project.accountId);
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
      await emailSessionLifecycle.continueSession({
        source: 'email',
        sessionId,
        text: renderFollowUpPrompt(event),
        opencodeEnv: { KORTIX_CONNECTORS_MCP_ENABLED: '1' },
      });
    }
    return;
  }

  const initialPrompt = renderAgentPrompt(event, revived);
  const emailConnectionId = await loadEmailInstallConnectionId(projectId, inboxId);
  if (!emailConnectionId) {
    console.error('[email-webhook] no active connection for inbox', {
      projectId,
      inboxId,
    });
    return;
  }
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
      title_source: messageSubject(event) ?? messageSummary(event),
    },
    enforceAccountCap: false,
    mayManageSystemConnections: true,
    queuePolicy: 'on_backpressure',
    idempotencyKey: claimKey,
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
    visibility: 'project',
    metadata: {
      source: 'email',
      email: {
        inbox_id: inboxId,
        thread_id: threadId,
        message_id: event.message.message_id,
        address: event.message.to?.[0] ?? '',
        from: messageSender(event),
        subject: messageSubject(event),
      },
    },
    extraEnvVars: {
      // Email delivery cannot depend on a shell fallback. Enable the
      // session-scoped MCP face so OpenCode exposes the bound inbox as tools.
      KORTIX_CONNECTORS_MCP_ENABLED: '1',
      KORTIX_EMAIL_INBOX_ID: inboxId,
      KORTIX_EMAIL_THREAD_ID: threadId,
      KORTIX_EMAIL_MESSAGE_ID: event.message.message_id,
      KORTIX_EMAIL_ADDRESS: event.message.to?.[0] ?? '',
      KORTIX_FRONTEND_URL: config.FRONTEND_URL,
    },
  });

  if (result.error) {
    console.error('[email-webhook] createProjectSession failed', {
      status: result.error.status,
      body: result.error.body,
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
    return inserted.length === 0;
  } catch (err) {
    console.warn('[email-webhook] event dedup check failed', err);
    return false;
  }
}

async function claimInboundMessage(event: AgentMailMessageReceivedEvent): Promise<boolean> {
  const key = `email:msg:${event.message.inbox_id}:${event.message.message_id}`;
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
    const [row] = await db
      .select({ sessionId: chatThreads.sessionId })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.platform, 'email'),
          eq(chatThreads.workspaceId, inboxId),
          eq(chatThreads.threadId, threadId),
        ),
      )
      .limit(1);
    if (row) return row.sessionId;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

function emailTurnInstructions(event: AgentMailMessageReceivedEvent): string {
  const readThreadCall = JSON.stringify({
    connector: 'email',
    action: 'get_thread',
    args: {
      inbox_id: event.message.inbox_id,
      thread_id: event.message.thread_id,
    },
  });
  const replyCall = JSON.stringify({
    connector: 'email',
    action: 'reply_message',
    args: {
      inbox_id: event.message.inbox_id,
      message_id: event.message.message_id,
      text: '<reply>',
    },
  });
  return [
    'How to work:',
    '- You are operating an AgentMail inbox assigned to this Kortix project.',
    '- Use the Connector MCP meta-tools `connectors`, `discover`, `describe`, and `call`. Connector actions are not direct tools.',
    '- Start with `connectors`. Use `discover` to find an action and `describe` to confirm its input schema before the first call.',
    `- Read the current thread with \`call\`: \`${readThreadCall}\`.`,
    `- Reply in the same conversation with \`call\`: \`${replyCall}\`. Use \`html\` instead of \`text\` only when needed.`,
    '- Start a new outbound email with `call`, connector `email`, action `send_message`, and args containing `inbox_id`, `to`, `subject`, and `text` or `html`.',
    '- The AgentMail API key is resolved server-side. Do not look for it in the sandbox.',
    '- If you need the user to clarify something, reply by email and end the turn. Their next reply will resume this same session.',
  ].join('\n');
}

function renderFollowUpPrompt(event: AgentMailMessageReceivedEvent): string {
  return [
    `New email reply from ${messageSender(event)} in the same thread:`,
    '',
    messageSummary(event),
    '',
    emailTurnInstructions(event),
  ].join('\n');
}

function renderAgentPrompt(event: AgentMailMessageReceivedEvent, revived: boolean): string {
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
    `Inbox ID:   ${event.message.inbox_id}`,
    `Thread ID:  ${event.message.thread_id}`,
    `Message ID: ${event.message.message_id}`,
    `From:       ${messageSender(event)}`,
    `To:         ${(event.message.to ?? []).join(', ')}`,
    `Subject:    ${messageSubject(event) ?? '(no subject)'}`,
    '',
    messageSummary(event),
    '',
    emailTurnInstructions(event),
  );
  return lines.join('\n');
}

function isInboundMessageEvent(eventType: AgentMailMessageReceivedEvent['event_type']): boolean {
  return eventType === 'message.received' || eventType === 'message.received.unauthenticated';
}

function messageSubject(event: AgentMailMessageReceivedEvent): string | null {
  return event.message.subject ?? event.thread?.subject ?? null;
}

function messageSummary(event: AgentMailMessageReceivedEvent): string {
  const body = event.message.extracted_text || event.message.text || event.message.preview || '';
  const attachments = event.message.attachments?.length
    ? [
        '',
        'Attachments:',
        ...event.message.attachments.map(
          (a) =>
            `- ${a.filename ?? a.attachment_id} (${a.content_type ?? 'unknown'}, ${a.size} bytes)`,
        ),
      ].join('\n')
    : '';
  return ['Email body:', body || '(empty)', attachments].filter(Boolean).join('\n');
}

function messageSender(event: AgentMailMessageReceivedEvent): string {
  if (typeof event.message.from === 'string' && event.message.from.trim()) {
    return event.message.from.trim();
  }
  const from = event.message.from_;
  if (typeof from === 'string') return from.trim();
  if (Array.isArray(from)) {
    const first = from[0];
    if (typeof first === 'string') return first.trim();
    if (first && typeof first === 'object') {
      return (first.email ?? first.address ?? first.name ?? '').trim();
    }
  }
  return '';
}

const MAILBOX_PATTERN = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

/**
 * Resolve the one canonical From mailbox AgentMail delivered.
 *
 * A substring match is not an authorization boundary: a crafted value such
 * as `allowed@example.com <attacker@evil.test>` contains an allowlisted
 * address even though the actual mailbox is the value in angle brackets.
 * Accept either a bare address or one ordinary `Display Name <address>`
 * mailbox, and reject ambiguous/multi-address values entirely.
 */
function senderEmail(event: AgentMailMessageReceivedEvent): string | null {
  const primary = event.message.from;
  const alternate = event.message.from_;
  const primaryMailbox =
    typeof primary === 'string' && primary.trim() ? canonicalMailbox(primary) : null;
  const alternateMailbox = canonicalStructuredMailbox(alternate);
  if (primaryMailbox && alternate !== undefined) {
    return alternateMailbox === primaryMailbox ? primaryMailbox : null;
  }
  if (typeof primary === 'string' && primary.trim()) return primaryMailbox;
  return alternateMailbox;
}

function canonicalStructuredMailbox(
  from: AgentMailMessageReceivedEvent['message']['from_'],
): string | null {
  if (Array.isArray(from)) {
    if (from.length !== 1) return null;
    const [first] = from;
    if (typeof first === 'string') return canonicalMailbox(first);
    if (!first || typeof first !== 'object') return null;
    const rawEmail = typeof first.email === 'string' ? first.email.trim() : '';
    const rawAddress = typeof first.address === 'string' ? first.address.trim() : '';
    const email = rawEmail ? canonicalMailbox(rawEmail) : null;
    const address = rawAddress ? canonicalMailbox(rawAddress) : null;
    // AgentMail payload variants have used both keys. Treat them as aliases,
    // but never choose one silently when a malformed or conflicting second
    // value is present: either condition makes the sender ambiguous.
    if ((rawEmail && !email) || (rawAddress && !address)) return null;
    if (email && address && email !== address) return null;
    return email ?? address;
  }
  return typeof from === 'string' ? canonicalMailbox(from) : null;
}

function canonicalMailbox(value: string): string | null {
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

export function isAgentMailSenderAllowedForTest(
  event: AgentMailMessageReceivedEvent,
  policy: AgentMailSenderPolicy,
): boolean {
  if (policy.mode !== 'restricted') return true;
  const email = senderEmail(event);
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

function senderAllowed(
  event: AgentMailMessageReceivedEvent,
  policy: AgentMailSenderPolicy,
): boolean {
  return isAgentMailSenderAllowedForTest(event, policy);
}
