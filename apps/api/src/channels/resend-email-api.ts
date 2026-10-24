/**
 * Resend, the email channel's provider: inboxes on a verified domain, their
 * threads, replies, receiving domains and the `inbox.email.received` webhook.
 *
 * One Resend team can hold many inboxes. The managed team is Kortix's
 * (`RESEND_API_KEY`); a project can bring its own team's key instead.
 */
import { config } from '../config';

const RESEND_REQUEST_TIMEOUT_MS = 15_000;

/** The webhook event a received inbox email arrives as. */
export const RESEND_INBOX_EMAIL_RECEIVED = 'inbox.email.received';

export class ResendEmailApiError extends Error {
  readonly status: number | null;
  readonly body: unknown;
  readonly path: string;

  constructor(input: { message: string; status: number | null; body: unknown; path: string }) {
    super(input.message);
    this.name = 'ResendEmailApiError';
    this.status = input.status;
    this.body = input.body;
    this.path = input.path;
  }
}

function baseUrl(): string {
  return config.RESEND_API_URL.replace(/\/+$/, '');
}

/** The project's own key, else Kortix's managed team key. */
export function resolveEmailApiKey(projectKey?: string | null): string | null {
  return projectKey || config.RESEND_API_KEY || null;
}

export function emailUpstreamStatus(err: unknown): number | null {
  return err instanceof ResendEmailApiError ? err.status : null;
}

/** Resend's own readable reason for a refused request. */
export function resendRefusal(err: unknown): string | null {
  if (!(err instanceof ResendEmailApiError)) return null;
  const body = err.body as { message?: unknown } | null;
  if (typeof body?.message === 'string' && body.message.trim()) return body.message.trim();
  return err.message || null;
}

async function resendRequest<T>(
  apiKey: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESEND_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = controller.signal.aborted;
    throw new ResendEmailApiError({
      message: timedOut ? 'Resend request timed out' : err instanceof Error ? err.message : 'Resend request failed',
      status: timedOut ? 504 : null,
      body: null,
      path,
    });
  } finally {
    clearTimeout(timeout);
  }
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const msg =
      typeof data?.message === 'string' ? data.message : typeof data?.name === 'string' ? data.name : text || `HTTP ${res.status}`;
    throw new ResendEmailApiError({ message: msg, status: res.status, body: data, path });
  }
  return data as T;
}

// ─── Inboxes ────────────────────────────────────────────────────────────────

export interface ResendInbox {
  id: string;
  email_address: string;
  name?: string | null;
  from_name?: string | null;
}

/**
 * Create an inbox at `address`. Resend answers 422 when the domain cannot
 * receive yet, 409 when the address is taken and 403 at the plan's inbox limit.
 */
export async function createResendInbox(input: {
  apiKey: string;
  address: string;
  fromName?: string | null;
}): Promise<ResendInbox> {
  const created = await resendRequest<{ id: string }>(input.apiKey, '/inboxes', {
    method: 'POST',
    body: {
      email_address: input.address,
      ...(input.fromName ? { from_name: input.fromName } : {}),
    },
  });
  return { id: created.id, email_address: input.address, from_name: input.fromName ?? null };
}

export async function getResendInbox(apiKey: string, inboxId: string): Promise<ResendInbox> {
  return resendRequest<ResendInbox>(apiKey, `/inboxes/${encodeURIComponent(inboxId)}`);
}

/** True when Resend deleted it or it was already gone (404). */
async function deleteIgnoringMissing(apiKey: string, path: string): Promise<void> {
  try {
    await resendRequest(apiKey, path, { method: 'DELETE' });
  } catch (err) {
    if (emailUpstreamStatus(err) === 404) return;
    throw err;
  }
}

export async function deleteResendInbox(apiKey: string, inboxId: string): Promise<void> {
  await deleteIgnoringMissing(apiKey, `/inboxes/${encodeURIComponent(inboxId)}`);
}

export async function deleteResendWebhook(apiKey: string, webhookId: string): Promise<void> {
  await deleteIgnoringMissing(apiKey, `/webhooks/${encodeURIComponent(webhookId)}`);
}

// ─── Thread emails ──────────────────────────────────────────────────────────

export interface ResendThreadEmail {
  id: string;
  direction?: 'inbound' | 'outbound';
  from?: string | null;
  to?: string[];
  cc?: string[];
  reply_to?: string[];
  subject?: string | null;
  message_id?: string | null;
  html?: string | null;
  text?: string | null;
  attachments?: Array<{ id: string; filename?: string | null; size?: number | null }>;
  received_at?: string;
}

/** One email of a thread, with its body (the webhook carries none). */
export async function getResendThreadEmail(input: {
  apiKey: string;
  inboxId: string;
  threadId: string;
  emailId: string;
}): Promise<ResendThreadEmail> {
  return resendRequest<ResendThreadEmail>(
    input.apiKey,
    `/inboxes/${encodeURIComponent(input.inboxId)}/threads/${encodeURIComponent(input.threadId)}/emails/${encodeURIComponent(input.emailId)}`,
  );
}

/** Reply in the thread, from the inbox address. */
export async function replyToResendThreadEmail(input: {
  apiKey: string;
  inboxId: string;
  threadId: string;
  emailId: string;
  text: string;
}): Promise<void> {
  await resendRequest(
    input.apiKey,
    `/inboxes/${encodeURIComponent(input.inboxId)}/threads/${encodeURIComponent(input.threadId)}/emails/${encodeURIComponent(input.emailId)}/reply`,
    { method: 'POST', body: { text: input.text } },
  );
}

// ─── Webhooks ───────────────────────────────────────────────────────────────

export interface ResendWebhook {
  id: string;
  signing_secret: string;
}

interface ResendWebhookRow {
  id: string;
  endpoint: string;
  events?: string[];
  status?: string;
  signing_secret?: string;
}

/**
 * The team's webhook for `endpoint` that sends `inbox.email.received`, created
 * once. A team-wide webhook carries every inbox's mail: dev, staging and prod
 * each register their own endpoint and ignore inboxes they do not know.
 */
export async function ensureResendInboxWebhook(apiKey: string, endpoint: string): Promise<ResendWebhook> {
  const list = await resendRequest<{ data?: ResendWebhookRow[] }>(apiKey, '/webhooks');
  const existing = (list.data ?? []).find(
    (hook) => hook.endpoint === endpoint && (hook.events ?? []).includes(RESEND_INBOX_EMAIL_RECEIVED),
  );
  if (existing) {
    const full =
      existing.signing_secret
        ? existing
        : await resendRequest<ResendWebhookRow>(apiKey, `/webhooks/${encodeURIComponent(existing.id)}`);
    if (full.signing_secret) return { id: existing.id, signing_secret: full.signing_secret };
  }
  const created = await resendRequest<ResendWebhookRow>(apiKey, '/webhooks', {
    method: 'POST',
    body: { endpoint, events: [RESEND_INBOX_EMAIL_RECEIVED] },
  });
  if (!created.signing_secret) {
    throw new ResendEmailApiError({ message: 'Resend returned no webhook signing secret', status: 502, body: null, path: '/webhooks' });
  }
  return { id: created.id, signing_secret: created.signing_secret };
}

// ─── Domains ────────────────────────────────────────────────────────────────

export interface ResendDnsRecord {
  record?: string;
  name: string;
  type: string;
  value: string;
  status?: string;
  priority?: number;
  ttl?: string;
}

export interface ResendDomain {
  id: string;
  name: string;
  status: string;
  region?: string;
  capabilities?: { sending?: string; receiving?: string };
  records?: ResendDnsRecord[];
}

/** A domain an inbox can live on: verified and receiving. */
export function resendDomainReady(domain: ResendDomain): boolean {
  return domain.status === 'verified' && domain.capabilities?.receiving === 'enabled';
}

/** The team's domains, each with its DNS records (the list omits them). */
export async function listResendDomains(apiKey: string): Promise<ResendDomain[]> {
  const list = await resendRequest<{ data?: Array<{ id: string }> }>(apiKey, '/domains');
  return Promise.all((list.data ?? []).map((d) => getResendDomain(apiKey, d.id)));
}

export async function getResendDomain(apiKey: string, domainId: string): Promise<ResendDomain> {
  return resendRequest<ResendDomain>(apiKey, `/domains/${encodeURIComponent(domainId)}`);
}

/** Add a domain that can send and receive, so inboxes can live on it. */
export async function createResendDomain(apiKey: string, name: string): Promise<ResendDomain> {
  const created = await resendRequest<ResendDomain>(apiKey, '/domains', {
    method: 'POST',
    body: { name, capabilities: { sending: 'enabled', receiving: 'enabled' } },
  });
  return created.records ? created : getResendDomain(apiKey, created.id);
}

/**
 * Ask Resend to check the DNS records again, then read the result. A verified
 * domain that does not receive yet gets receiving switched on, which adds the
 * MX record to its records.
 */
export async function verifyResendDomain(apiKey: string, domainId: string): Promise<ResendDomain> {
  const current = await getResendDomain(apiKey, domainId);
  if (current.capabilities?.receiving !== 'enabled') {
    await resendRequest(apiKey, `/domains/${encodeURIComponent(domainId)}`, {
      method: 'PATCH',
      body: { capabilities: { receiving: 'enabled' } },
    });
  }
  await resendRequest(apiKey, `/domains/${encodeURIComponent(domainId)}/verify`, { method: 'POST' });
  return getResendDomain(apiKey, domainId);
}
