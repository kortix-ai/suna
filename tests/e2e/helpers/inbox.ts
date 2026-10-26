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

interface ResendInboxResponse {
  id: string;
}

interface ResendList<T> {
  data: T[];
}

interface ResendThread {
  id: string;
  received_at: string;
}

interface ResendThreadEmail {
  id: string;
  direction?: string;
  text?: string | null;
  html?: string | null;
  received_at: string;
}

interface ResendInboxSummary {
  id: string;
  email_address: string;
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
      .filter((candidate) => new Date(candidate.Created).getTime() >= after.getTime())
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

const RESEND_API_URL = () => (process.env.E2E_RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, "");
/** A domain with receiving on in the E2E Resend team. */
const RESEND_INBOX_DOMAIN = () => process.env.E2E_RESEND_INBOX_DOMAIN?.trim() || "kortix.cloud";
const E2E_INBOX_PREFIX = "kortix-e2e-";

/** Delete this suite's own leaked inboxes (`kortix-e2e-*`), never anyone else's. */
async function purgeE2eInboxes(baseUrl: string, headers: Record<string, string>): Promise<void> {
  const res = await fetch(`${baseUrl}/inboxes?limit=100`, { headers });
  if (!res.ok) return;
  const body = (await res.json().catch(() => ({}))) as Partial<ResendList<ResendInboxSummary>>;
  const mine = (body.data ?? []).filter((entry) => entry.email_address?.startsWith(E2E_INBOX_PREFIX));
  await Promise.all(
    mine.map((entry) =>
      fetch(`${baseUrl}/inboxes/${encodeURIComponent(entry.id)}`, { method: "DELETE", headers }).catch(
        () => undefined,
      ),
    ),
  );
}

async function resendInbox(apiKey: string): Promise<DisposableInbox> {
  const baseUrl = RESEND_API_URL();
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const unique = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const email = `${E2E_INBOX_PREFIX}${unique}@${RESEND_INBOX_DOMAIN()}`;
  const createOnce = () =>
    fetch(`${baseUrl}/inboxes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email_address: email, name: "Kortix E2E" }),
    });

  // A team at its plan's inbox limit answers 403. E2E inboxes are ephemeral,
  // but a crashed run can leak them: on 403, sweep our OWN leaked inboxes and
  // retry once.
  let created = await createOnce();
  if (created.status === 403) {
    await purgeE2eInboxes(baseUrl, headers);
    created = await createOnce();
  }
  const inbox = await json<ResendInboxResponse>(created, 200);
  const inboxPath = `${baseUrl}/inboxes/${encodeURIComponent(inbox.id)}`;
  // `received_at` can fall up to a second before the send that produced it,
  // so read 2 s back and skip messages this inbox already returned: an earlier
  // email never answers a later wait.
  const returned = new Set<string>();

  const readLatestMessage = async (after: Date): Promise<string | null> => {
    const since = new Date(after.getTime() - 2_000).getTime();
    const threads = await json<ResendList<ResendThread>>(
      await fetch(`${inboxPath}/threads?limit=10`, { headers }),
      200,
    );
    const newest: ResendThreadEmail[] = [];
    for (const thread of threads.data.filter((t) => new Date(t.received_at).getTime() >= since)) {
      const emails = await json<ResendList<ResendThreadEmail>>(
        await fetch(`${inboxPath}/threads/${encodeURIComponent(thread.id)}/emails?limit=20`, { headers }),
        200,
      );
      newest.push(
        ...emails.data.filter(
          (m) => m.direction !== "outbound" && !returned.has(m.id) && new Date(m.received_at).getTime() >= since,
        ),
      );
    }
    const message = newest.sort(
      (left, right) => new Date(right.received_at).getTime() - new Date(left.received_at).getTime(),
    )[0];
    if (!message) return null;
    returned.add(message.id);
    return `${message.text ?? ""}\n${message.html ?? ""}`;
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
    async dispose() {
      const response = await fetch(inboxPath, { method: "DELETE", headers });
      if (![200, 202, 204, 404].includes(response.status)) {
        throw new Error(`Resend inbox cleanup returned ${response.status}`);
      }
    },
  };
}

export async function createDisposableInbox(): Promise<DisposableInbox> {
  const resendApiKey = process.env.E2E_RESEND_API_KEY?.trim();
  if (resendApiKey) return resendInbox(resendApiKey);

  const mailpitUrl = process.env.E2E_MAILPIT_URL?.trim();
  if (mailpitUrl) return localMailpitInbox(mailpitUrl);

  throw new Error(
    "browser authentication requires E2E_MAILPIT_URL locally or E2E_RESEND_API_KEY on a deployed target",
  );
}

export interface EmailProviderStatus {
  available: boolean;
  reason: string;
}

let emailProviderStatusPromise: Promise<EmailProviderStatus> | null = null;

/**
 * Whether an email inbox provider is actually usable — probed once per process.
 * Mailpit (local) is authoritative by presence. For Resend on a deployed
 * target the key can be present but rejected (revoked or send-only → 401/403),
 * so we make one live call. Email-dependent specs use this to `test.skip` with
 * a clear reason instead of hard-failing inbox creation.
 *
 * NOTE: on the strict deployed lane (`E2E_REQUIRE_ALL_BROWSER=1`) a skip is
 * still converted to a failure by strict-skip-reporter.ts — by design, a
 * release gate must surface broken email delivery. This graceful skip therefore
 * only degrades cleanly on local / non-strict runs.
 */
export function emailProviderStatus(): Promise<EmailProviderStatus> {
  if (emailProviderStatusPromise) return emailProviderStatusPromise;
  emailProviderStatusPromise = (async () => {
    const mailpitUrl = process.env.E2E_MAILPIT_URL?.trim();
    if (mailpitUrl) return { available: true, reason: "mailpit" };

    const resendApiKey = process.env.E2E_RESEND_API_KEY?.trim();
    if (resendApiKey) {
      try {
        const res = await fetch(`${RESEND_API_URL()}/inboxes?limit=1`, {
          headers: { Authorization: `Bearer ${resendApiKey}` },
        });
        return res.ok
          ? { available: true, reason: "resend" }
          : { available: false, reason: `Resend key rejected (HTTP ${res.status})` };
      } catch (error) {
        return { available: false, reason: `Resend unreachable: ${String(error)}` };
      }
    }

    return {
      available: false,
      reason: "no email provider (set E2E_MAILPIT_URL or a valid E2E_RESEND_API_KEY)",
    };
  })();
  return emailProviderStatusPromise;
}
