import { chatEventDedup, chatInstalls, chatThreads, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { config } from '../../config';
import {
  continueSession as continueLifecycleSession,
  createSession as createLifecycleSession,
  resolveProjectAutomationActor as resolveLifecycleAutomationActor,
} from '../../projects/session-lifecycle';
import { db } from '../../shared/db';
import { WHATSAPP_EVENT_DEDUPE_TTL_MS } from './app';
import { asMessageData, type WhatsAppGatewayEvent, type WhatsAppMessageData } from './types';

const defaultWhatsAppSessionLifecycle = {
  continueSession: continueLifecycleSession,
  createSession: createLifecycleSession,
  resolveProjectAutomationActor: resolveLifecycleAutomationActor,
};

let whatsappSessionLifecycle = defaultWhatsAppSessionLifecycle;

export function setWhatsAppSessionLifecycleForTest(
  overrides: Partial<typeof defaultWhatsAppSessionLifecycle>,
) {
  whatsappSessionLifecycle = { ...defaultWhatsAppSessionLifecycle, ...overrides };
}

export function resetWhatsAppSessionLifecycleForTest() {
  whatsappSessionLifecycle = defaultWhatsAppSessionLifecycle;
}

/** A gateway connection (account_id) is the workspace identity for this channel. */
export async function resolveProjectForWhatsAppAccount(accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'whatsapp'), eq(chatInstalls.workspaceId, accountId)))
    .limit(1);
  return row?.projectId ?? null;
}

export async function dispatchWhatsAppEvent(event: WhatsAppGatewayEvent): Promise<void> {
  if (event.type !== 'message.created') return;

  const message = asMessageData(event);
  if (!message) return;

  // Never react to our own sends. The gateway emits message.created for both
  // directions, so echoing outbound messages back into the session would loop
  // the agent against itself.
  if (message.direction !== 'inbound') return;

  if (await alreadyHandled(`whatsapp:event:${event.id}`)) return;

  const projectId = await resolveProjectForWhatsAppAccount(event.account_id);
  if (!projectId) {
    console.warn('[whatsapp-webhook] no project install for gateway account', {
      accountId: event.account_id,
      eventId: event.id,
    });
    return;
  }

  if (!(await claimInboundMessage(event.account_id, message.id))) return;
  await spawnWhatsAppAgentTurn(projectId, event, message);
}

async function spawnWhatsAppAgentTurn(
  projectId: string,
  event: WhatsAppGatewayEvent,
  message: WhatsAppMessageData,
): Promise<void> {
  const accountId = event.account_id;
  const chatJid = message.chat_jid;
  if (!accountId || !chatJid) return;

  const [existing] = await db
    .select({ sessionId: chatThreads.sessionId })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.platform, 'whatsapp'),
        eq(chatThreads.workspaceId, accountId),
        eq(chatThreads.threadId, chatJid),
      ),
    )
    .limit(1);

  if (existing) {
    const outcome = await whatsappSessionLifecycle.continueSession({
      source: 'whatsapp',
      sessionId: existing.sessionId,
      text: renderFollowUpPrompt(message),
    });
    if (outcome === 'delivered') {
      await db
        .update(chatThreads)
        .set({ lastMessageAt: new Date() })
        .where(
          and(
            eq(chatThreads.platform, 'whatsapp'),
            eq(chatThreads.workspaceId, accountId),
            eq(chatThreads.threadId, chatJid),
          ),
        );
    } else if (outcome === 'no-session') {
      await db
        .delete(chatThreads)
        .where(
          and(
            eq(chatThreads.platform, 'whatsapp'),
            eq(chatThreads.workspaceId, accountId),
            eq(chatThreads.threadId, chatJid),
          ),
        );
      await createThreadSession(projectId, event, message, true);
    }
    return;
  }

  await createThreadSession(projectId, event, message, false);
}

async function createThreadSession(
  projectId: string,
  event: WhatsAppGatewayEvent,
  message: WhatsAppMessageData,
  revived: boolean,
): Promise<void> {
  const accountId = event.account_id;
  const chatJid = message.chat_jid;

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!project) return;

  const userId = await whatsappSessionLifecycle.resolveProjectAutomationActor(project.accountId);
  if (!userId) {
    console.warn('[whatsapp-webhook] no actor for project', projectId);
    return;
  }

  const claimKey = `whatsapp:threadcreate:${accountId}:${chatJid}`;
  if (!(await claimThreadCreate(claimKey))) {
    // Another replica is creating the session for this chat; wait for it and
    // deliver this message into the winner's session instead.
    const sessionId = await waitForThreadSession(accountId, chatJid);
    if (sessionId) {
      await whatsappSessionLifecycle.continueSession({
        source: 'whatsapp',
        sessionId,
        text: renderFollowUpPrompt(message),
      });
    }
    return;
  }

  const result = await whatsappSessionLifecycle.createSession({
    source: 'whatsapp',
    project,
    userId,
    requestingPrincipalType: 'human',
    body: {
      base_ref: project.defaultBranch,
      agent_name: 'default',
    },
    enforceAccountCap: false,
    queuePolicy: 'on_backpressure',
    idempotencyKey: claimKey,
    postCreate: [
      {
        type: 'bind_chat_thread',
        platform: 'whatsapp',
        workspaceId: accountId,
        threadId: chatJid,
      },
      {
        type: 'deliver_prompt',
        source: 'whatsapp',
        text: renderAgentPrompt(event, message, revived),
        userId,
      },
    ],
    visibility: 'project',
    metadata: {
      source: 'whatsapp',
      whatsapp: {
        account_id: accountId,
        chat_jid: chatJid,
        message_id: message.id,
        sender_jid: message.sender_jid,
      },
    },
    extraEnvVars: {
      KORTIX_WHATSAPP_ACCOUNT_ID: accountId,
      KORTIX_WHATSAPP_CHAT_JID: chatJid,
      KORTIX_WHATSAPP_MESSAGE_ID: message.id,
      KORTIX_FRONTEND_URL: config.FRONTEND_URL,
    },
  });

  if (result.error) {
    console.error('[whatsapp-webhook] createProjectSession failed', {
      status: result.error.status,
      body: result.error.body,
    });
  }
}

async function claim(key: string, failOpen: boolean): Promise<boolean> {
  try {
    const inserted = await db
      .insert(chatEventDedup)
      .values({
        eventId: key,
        expiresAt: new Date(Date.now() + WHATSAPP_EVENT_DEDUPE_TTL_MS),
      })
      .onConflictDoNothing({ target: chatEventDedup.eventId })
      .returning({ eventId: chatEventDedup.eventId });
    return inserted.length > 0;
  } catch (err) {
    console.warn('[whatsapp-webhook] dedup claim failed', { key, err });
    return failOpen;
  }
}

async function alreadyHandled(key: string): Promise<boolean> {
  // Claim failure here means "treat as already handled" so a database blip
  // cannot fan out duplicate agent turns.
  return !(await claim(key, false));
}

async function claimInboundMessage(accountId: string, messageId: string): Promise<boolean> {
  return claim(`whatsapp:msg:${accountId}:${messageId}`, true);
}

async function claimThreadCreate(key: string): Promise<boolean> {
  return claim(key, true);
}

async function waitForThreadSession(accountId: string, chatJid: string): Promise<string | null> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const [row] = await db
      .select({ sessionId: chatThreads.sessionId })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.platform, 'whatsapp'),
          eq(chatThreads.workspaceId, accountId),
          eq(chatThreads.threadId, chatJid),
        ),
      )
      .limit(1);
    if (row) return row.sessionId;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

const WHATSAPP_TURN_INSTRUCTIONS = [
  'How to work:',
  '- You are answering on a WhatsApp number connected to this Kortix project.',
  '- Reply with the `whatsapp` Executor connector. `whatsapp.send_text` takes account_id,',
  '  to (the chat JID below) and text. Credentials resolve server-side; there is no API key,',
  '  CLI, or skill file in the sandbox and you should not look for one.',
  '- Call `whatsapp.set_presence` with state "composing" before writing, so the person sees a',
  '  typing indicator, and `whatsapp.mark_read` once you have handled their message.',
  '- Other actions: list_messages (q searches text), list_chats, list_contacts, list_groups,',
  '  get_media to look at an attachment, react, and run_action for anything else.',
  '- Write like a person, not a product. WhatsApp markup is *bold*, _italic_, ~strike~ —',
  '  Markdown does NOT render, so never use **bold**, headings, tables, or bullet lists.',
  '  Keep replies to one to three sentences and match their language.',
  '- If you need more detail on the API, the gateway publishes its own docs and guidance:',
  '  <gateway>/openapi.json, <gateway>/v1/skill.md and <gateway>/v1/chat.md.',
  '- If you need the person to clarify something, ask in the chat and end the turn.',
  '  Their next message resumes this same session.',
].join('\n');

function describeMessage(message: WhatsAppMessageData): string {
  const body = message.text?.trim();
  if (body) return body;
  return `(${message.type} message with no text body)`;
}

function renderFollowUpPrompt(message: WhatsAppMessageData): string {
  return [
    `New WhatsApp message from ${message.sender_jid ?? message.chat_jid}:`,
    '',
    describeMessage(message),
    '',
    WHATSAPP_TURN_INSTRUCTIONS,
  ].join('\n');
}

function renderAgentPrompt(
  event: WhatsAppGatewayEvent,
  message: WhatsAppMessageData,
  revived: boolean,
): string {
  const lines: string[] = [];
  if (revived) {
    lines.push(
      'NOTE: This WhatsApp chat had an earlier conversation, but that session was deleted.',
      'Pick the conversation back up from the current message.',
      '',
    );
  }
  lines.push(
    "You're answering a WhatsApp chat as the Kortix agent.",
    '',
    `Connection: ${event.account_id}`,
    `Chat JID:   ${message.chat_jid}`,
    `Sender:     ${message.sender_jid ?? '(direct chat)'}`,
    `Message ID: ${message.id}`,
    '',
    describeMessage(message),
    '',
    WHATSAPP_TURN_INSTRUCTIONS,
  );
  return lines.join('\n');
}
