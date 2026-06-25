import { and, eq } from "drizzle-orm";
import {
  chatEventDedup,
  chatInstalls,
  chatThreads,
  projects,
} from "@kortix/db";
import { db } from "../../shared/db";
import {
  type AgentMailSenderPolicy,
  loadAgentMailSenderPolicyForInbox,
} from "../install-store";
import {
  continueSession as continueLifecycleSession,
  createSession as createLifecycleSession,
  resolveProjectAutomationActor as resolveLifecycleAutomationActor,
} from "../../projects/session-lifecycle";
import { config } from "../../config";
import { EMAIL_EVENT_DEDUPE_TTL_MS } from "./app";
import type { AgentMailMessageReceivedEvent } from "./types";

const defaultEmailSessionLifecycle = {
  continueSession: continueLifecycleSession,
  createSession: createLifecycleSession,
  resolveProjectAutomationActor: resolveLifecycleAutomationActor,
};

let emailSessionLifecycle = defaultEmailSessionLifecycle;

export function setEmailSessionLifecycleForTest(
  overrides: Partial<typeof defaultEmailSessionLifecycle>,
) {
  emailSessionLifecycle = { ...defaultEmailSessionLifecycle, ...overrides };
}

export function resetEmailSessionLifecycleForTest() {
  emailSessionLifecycle = defaultEmailSessionLifecycle;
}

export async function resolveProjectForAgentMailInbox(
  inboxId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ projectId: chatInstalls.projectId })
    .from(chatInstalls)
    .where(
      and(
        eq(chatInstalls.platform, "email"),
        eq(chatInstalls.workspaceId, inboxId),
      ),
    )
    .limit(1);
  return row?.projectId ?? null;
}

export async function dispatchAgentMailEvent(
  event: AgentMailMessageReceivedEvent,
): Promise<void> {
  if (!isInboundMessageEvent(event.event_type)) return;
  if (await alreadyHandled(`email:event:${event.event_id}`)) return;
  const projectId = await resolveProjectForAgentMailInbox(
    event.message.inbox_id,
  );
  if (!projectId) {
    console.warn("[email-webhook] no project install for AgentMail inbox", {
      inboxId: event.message.inbox_id,
      eventId: event.event_id,
    });
    return;
  }
  const policy = await loadAgentMailSenderPolicyForInbox(
    projectId,
    event.message.inbox_id,
  );
  if (!senderAllowed(event, policy)) {
    console.warn("[email-webhook] sender rejected by AgentMail inbox policy", {
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
        eq(chatThreads.platform, "email"),
        eq(chatThreads.workspaceId, inboxId),
        eq(chatThreads.threadId, threadId),
      ),
    )
    .limit(1);

  if (existing) {
    const outcome = await emailSessionLifecycle.continueSession({
      source: "email",
      sessionId: existing.sessionId,
      text: renderFollowUpPrompt(event),
    });
    if (outcome === "delivered") {
      await db
        .update(chatThreads)
        .set({ lastMessageAt: new Date() })
        .where(
          and(
            eq(chatThreads.platform, "email"),
            eq(chatThreads.workspaceId, inboxId),
            eq(chatThreads.threadId, threadId),
          ),
        );
    } else if (outcome === "no-session") {
      await db
        .delete(chatThreads)
        .where(
          and(
            eq(chatThreads.platform, "email"),
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

  const userId = await emailSessionLifecycle.resolveProjectAutomationActor(
    project.accountId,
  );
  if (!userId) {
    console.warn("[email-webhook] no actor for project", projectId);
    return;
  }

  const claimKey = `email:threadcreate:${inboxId}:${threadId}`;
  if (!(await claimThreadCreate(claimKey))) {
    const sessionId = await waitForThreadSession(inboxId, threadId);
    if (sessionId) {
      await emailSessionLifecycle.continueSession({
        source: "email",
        sessionId,
        text: renderFollowUpPrompt(event),
      });
    }
    return;
  }

  const result = await emailSessionLifecycle.createSession({
    source: "email",
    project,
    userId,
    body: {
      base_ref: project.defaultBranch,
      agent_name: "default",
      initial_prompt: renderAgentPrompt(event, revived),
    },
    enforceAccountCap: false,
    queuePolicy: "on_backpressure",
    idempotencyKey: claimKey,
    postCreate: [
      {
        type: "bind_chat_thread",
        platform: "email",
        workspaceId: inboxId,
        threadId,
      },
    ],
    visibility: "project",
    metadata: {
      source: "email",
      email: {
        inbox_id: inboxId,
        thread_id: threadId,
        message_id: event.message.message_id,
        from: messageSender(event),
        subject: messageSubject(event),
      },
    },
    extraEnvVars: {
      KORTIX_EMAIL_INBOX_ID: inboxId,
      KORTIX_EMAIL_THREAD_ID: threadId,
      KORTIX_EMAIL_MESSAGE_ID: event.message.message_id,
      KORTIX_EMAIL_ADDRESS: event.message.to?.[0] ?? "",
      KORTIX_FRONTEND_URL: config.FRONTEND_URL,
    },
  });

  if (result.error) {
    console.error("[email-webhook] createProjectSession failed", {
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
    console.warn("[email-webhook] event dedup check failed", err);
    return false;
  }
}

async function claimInboundMessage(
  event: AgentMailMessageReceivedEvent,
): Promise<boolean> {
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
    console.error(
      "[email-webhook] inbound message claim failed (fail-open)",
      err,
    );
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
    console.warn("[email-webhook] thread-create claim failed (fail-open)", err);
    return true;
  }
}

async function waitForThreadSession(
  inboxId: string,
  threadId: string,
): Promise<string | null> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const [row] = await db
      .select({ sessionId: chatThreads.sessionId })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.platform, "email"),
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

const EMAIL_TURN_INSTRUCTIONS = [
  "How to work:",
  "- You are operating an AgentMail inbox assigned to this Kortix project.",
  "- Use the built-in `email` Executor connector for inbox operations. The AgentMail API key is resolved server-side; do not look for it in the sandbox.",
  "- Read the current thread before replying when context matters: `email.get_thread` with `inbox_id` and `thread_id`.",
  "- To answer in the same conversation, call `email.reply_message` with `inbox_id`, `message_id`, `text` or `html`, and attachments when needed.",
  "- For a brand-new outbound email, call `email.send_message` with `inbox_id`, `to`, `subject`, and body.",
  "- If you need the user to clarify something, reply by email and end the turn. Their next reply will resume this same session.",
].join("\n");

function renderFollowUpPrompt(event: AgentMailMessageReceivedEvent): string {
  return [
    `New email reply from ${messageSender(event)} in the same thread:`,
    "",
    messageSummary(event),
    "",
    EMAIL_TURN_INSTRUCTIONS,
  ].join("\n");
}

function renderAgentPrompt(
  event: AgentMailMessageReceivedEvent,
  revived: boolean,
): string {
  const lines: string[] = [];
  if (revived) {
    lines.push(
      "NOTE: This email thread had an earlier conversation, but that session was deleted.",
      "Pick the thread back up from the current email context.",
      "",
    );
  }
  lines.push(
    "You're answering an email thread as the Kortix agent.",
    "",
    `Inbox ID:   ${event.message.inbox_id}`,
    `Thread ID:  ${event.message.thread_id}`,
    `Message ID: ${event.message.message_id}`,
    `From:       ${messageSender(event)}`,
    `To:         ${(event.message.to ?? []).join(", ")}`,
    `Subject:    ${messageSubject(event) ?? "(no subject)"}`,
    "",
    messageSummary(event),
    "",
    EMAIL_TURN_INSTRUCTIONS,
  );
  return lines.join("\n");
}

function isInboundMessageEvent(eventType: AgentMailMessageReceivedEvent["event_type"]): boolean {
  return eventType === "message.received" || eventType === "message.received.unauthenticated";
}

function messageSubject(event: AgentMailMessageReceivedEvent): string | null {
  return event.message.subject ?? event.thread?.subject ?? null;
}

function messageSummary(event: AgentMailMessageReceivedEvent): string {
  const body =
    event.message.extracted_text ||
    event.message.text ||
    event.message.preview ||
    "";
  const attachments = event.message.attachments?.length
    ? [
        "",
        "Attachments:",
        ...event.message.attachments.map(
          (a) =>
            `- ${a.filename ?? a.attachment_id} (${a.content_type ?? "unknown"}, ${a.size} bytes)`,
        ),
      ].join("\n")
    : "";
  return [`Email body:`, body || "(empty)", attachments]
    .filter(Boolean)
    .join("\n");
}

function messageSender(event: AgentMailMessageReceivedEvent): string {
  if (typeof event.message.from === "string" && event.message.from.trim()) {
    return event.message.from.trim();
  }
  const from = event.message.from_;
  if (typeof from === "string") return from.trim();
  if (Array.isArray(from)) {
    const first = from[0];
    if (typeof first === "string") return first.trim();
    if (first && typeof first === "object") {
      return (first.email ?? first.address ?? first.name ?? "").trim();
    }
  }
  return "";
}

function senderEmail(event: AgentMailMessageReceivedEvent): string | null {
  const sender = messageSender(event).toLowerCase();
  const match = sender.match(
    /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i,
  );
  return match?.[0]?.toLowerCase() ?? null;
}

export function isAgentMailSenderAllowedForTest(
  event: AgentMailMessageReceivedEvent,
  policy: AgentMailSenderPolicy,
): boolean {
  if (policy.mode !== "restricted") return true;
  const email = senderEmail(event);
  if (!email) return false;
  if (policy.allowedEmails.includes(email)) return true;
  const domain = email.split("@")[1] ?? "";
  if (
    policy.allowedDomains.some(
      (allowed) => domain === allowed || domain.endsWith(`.${allowed}`),
    )
  ) {
    return true;
  }
  if (policy.allowedRegex) {
    try {
      return new RegExp(policy.allowedRegex, "i").test(email);
    } catch {
      return false;
    }
  }
  return false;
}

function senderAllowed(
  event: AgentMailMessageReceivedEvent,
  policy: AgentMailSenderPolicy,
): boolean {
  return isAgentMailSenderAllowedForTest(event, policy);
}
