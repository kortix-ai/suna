import { randomUUID } from "node:crypto";

import { json } from "./http";

export type AuthEmailAction =
  | { kind: "link"; value: string }
  | { kind: "code"; value: string };

export interface DisposableInbox {
  email: string;
  waitForAuthAction(after: Date): Promise<AuthEmailAction>;
  waitForInviteLink(after: Date): Promise<string>;
  dispose(): Promise<void>;
}

interface MailpitMessageSummary {
  ID: string;
  Created: string;
  To?: Array<{ Address?: string }>;
}

interface MailpitSearchResponse {
  messages?: MailpitMessageSummary[];
}

interface MailpitMessage {
  Text?: string;
  HTML?: string;
}

interface AgentMailInboxResponse {
  inbox_id: string;
  email: string;
}

interface AgentMailMessageSummary {
  message_id: string;
  timestamp: string;
}

interface AgentMailMessagesResponse {
  messages: AgentMailMessageSummary[];
}

interface AgentMailMessage {
  text?: string;
  html?: string;
}

const MAILPIT_TIMESTAMP_TOLERANCE_MS = 5_000;

export function mailpitMessageIsRecent(created: string, after: Date): boolean {
  const createdAt = new Date(created).getTime();
  return Number.isFinite(createdAt) && createdAt >= after.getTime() - MAILPIT_TIMESTAMP_TOLERANCE_MS;
}

function extractAuthAction(text: string): AuthEmailAction | null {
  const decoded = text.replaceAll("&amp;", "&");
  const urls = decoded.match(/https?:\/\/[^\s<>"')]+/g) ?? [];
  const verifyLink = urls.find((url) => url.includes("/auth/v1/verify?"));
  if (verifyLink) return { kind: "link", value: verifyLink };

  const code = decoded.match(/(?:^|\D)(\d{6})(?:\D|$)/)?.[1];
  return code ? { kind: "code", value: code } : null;
}

function extractInviteLink(text: string): string | null {
  const decoded = text.replaceAll("&amp;", "&");
  return (decoded.match(/https?:\/\/[^\s<>"')]+/g) ?? []).find((url) =>
    /\/invites\/[0-9a-f-]+(?:[/?#]|$)/i.test(url),
  ) ?? null;
}

async function waitForMessage<T>(
  read: () => Promise<T | null>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const action = await read();
      if (action) return action;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`authentication email did not arrive within ${timeoutMs}ms${suffix}`);
}

function localMailpitInbox(mailpitUrl: string): DisposableInbox {
  const email = `kortix-e2e-${Date.now()}-${randomUUID().slice(0, 8)}@example.test`;
  const baseUrl = mailpitUrl.replace(/\/+$/, "");
  const readLatestMessage = async (after: Date): Promise<string | null> => {
    const searchUrl = new URL(`${baseUrl}/api/v1/search`);
    searchUrl.searchParams.set("query", `to:${email}`);
    const result = await json<MailpitSearchResponse>(await fetch(searchUrl), 200);
    const message = (result.messages ?? [])
      .filter((candidate) =>
        candidate.To?.some(
          (recipient) => recipient.Address?.toLowerCase() === email.toLowerCase(),
        ),
      )
      // Mailpit and the test process can stamp the same SMTP transaction on
      // opposite sides of a sub-second clock boundary. The recipient remains
      // unique, so a small tolerance cannot select another test's message.
      .filter((candidate) => mailpitMessageIsRecent(candidate.Created, after))
      .sort(
        (left, right) =>
          new Date(right.Created).getTime() - new Date(left.Created).getTime(),
      )[0];
    if (!message) return null;
    const detail = await json<MailpitMessage>(
      await fetch(`${baseUrl}/api/v1/message/${encodeURIComponent(message.ID)}`),
      200,
    );
    return `${detail.Text ?? ""}\n${detail.HTML ?? ""}`;
  };
  return {
    email,
    async waitForAuthAction(after) {
      return waitForMessage(async () => {
        const message = await readLatestMessage(after);
        return message ? extractAuthAction(message) : null;
      });
    },
    async waitForInviteLink(after) {
      return waitForMessage(async () => {
        const message = await readLatestMessage(after);
        return message ? extractInviteLink(message) : null;
      });
    },
    async dispose() {},
  };
}

async function agentMailInbox(apiKey: string): Promise<DisposableInbox> {
  const baseUrl = (process.env.E2E_AGENTMAIL_API_URL || "https://api.agentmail.to/v0").replace(
    /\/+$/,
    "",
  );
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const unique = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const inbox = await json<AgentMailInboxResponse>(
    await fetch(`${baseUrl}/inboxes`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        username: `kortix-e2e-${unique}`,
        display_name: "Kortix E2E",
        client_id: `kortix-browser-auth-${unique}`,
      }),
    }),
    200,
  );

  const readLatestMessage = async (after: Date): Promise<string | null> => {
    const listUrl = new URL(
      `${baseUrl}/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages`,
    );
    listUrl.searchParams.set("limit", "10");
    listUrl.searchParams.set("after", after.toISOString());
    listUrl.searchParams.set("include_unauthenticated", "true");
    const result = await json<AgentMailMessagesResponse>(
      await fetch(listUrl, { headers }),
      200,
    );
    const message = result.messages
      .filter((candidate) => new Date(candidate.timestamp).getTime() >= after.getTime())
      .sort(
        (left, right) =>
          new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime(),
      )[0];
    if (!message) return null;
    const detail = await json<AgentMailMessage>(
      await fetch(
        `${baseUrl}/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/${encodeURIComponent(message.message_id)}`,
        { headers },
      ),
      200,
    );
    return `${detail.text ?? ""}\n${detail.html ?? ""}`;
  };

  return {
    email: inbox.email,
    async waitForAuthAction(after) {
      return waitForMessage(async () => {
        const message = await readLatestMessage(after);
        return message ? extractAuthAction(message) : null;
      });
    },
    async waitForInviteLink(after) {
      return waitForMessage(async () => {
        const message = await readLatestMessage(after);
        return message ? extractInviteLink(message) : null;
      });
    },
    async dispose() {
      const response = await fetch(`${baseUrl}/inboxes/${encodeURIComponent(inbox.inbox_id)}`, {
        method: "DELETE",
        headers,
      });
      if (![200, 202, 204, 404].includes(response.status)) {
        throw new Error(`AgentMail inbox cleanup returned ${response.status}`);
      }
    },
  };
}

export async function createDisposableInbox(): Promise<DisposableInbox> {
  const agentMailApiKey = process.env.E2E_AGENTMAIL_API_KEY?.trim();
  if (agentMailApiKey) return agentMailInbox(agentMailApiKey);

  const mailpitUrl = process.env.E2E_MAILPIT_URL?.trim();
  if (mailpitUrl) return localMailpitInbox(mailpitUrl);

  throw new Error(
    "browser authentication requires E2E_MAILPIT_URL locally or E2E_AGENTMAIL_API_KEY on a deployed target",
  );
}
