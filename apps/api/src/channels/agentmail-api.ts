import { createHash } from 'node:crypto';
import { config } from '../config';

export interface AgentMailInbox {
  inbox_id: string;
  email: string;
  display_name?: string | null;
}

export interface AgentMailWebhook {
  webhook_id: string;
  secret: string;
}

const AGENTMAIL_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Stable, connection-scoped AgentMail idempotency keys.
 *
 * A Kortix project may contain several email connections. Project-only client ids
 * cause AgentMail to return the first inbox and webhook for every later connection.
 * Hash the project/connection tuple so retries remain idempotent while distinct
 * connections always provision distinct provider resources.
 */
export function agentMailProvisioningClientIds(projectId: string, connectionSlug: string) {
  const scope = createHash('sha256')
    .update(projectId)
    .update('\0')
    .update(connectionSlug.trim().toLowerCase())
    .digest('hex')
    .slice(0, 40);
  return {
    inbox: `kortix-inbox-${scope}`,
    webhook: `kortix-webhook-${scope}`,
  };
}

export class AgentMailApiError extends Error {
  readonly status: number | null;
  readonly body: unknown;
  readonly path: string;

  constructor(input: {
    message: string;
    status: number | null;
    body: unknown;
    path: string;
  }) {
    super(input.message);
    this.name = 'AgentMailApiError';
    this.status = input.status;
    this.body = input.body;
    this.path = input.path;
  }
}

function baseUrl(): string {
  return (config.AGENTMAIL_API_URL || 'https://api.agentmail.to/v0').replace(/\/+$/, '');
}

export function resolveAgentMailApiKey(projectKey?: string | null): string | null {
  return projectKey || config.AGENTMAIL_API_KEY || null;
}

export function isAgentMailInboxLimitError(err: unknown): boolean {
  if (!(err instanceof AgentMailApiError)) return false;
  const bodyText =
    typeof err.body === 'string' ? err.body : err.body ? JSON.stringify(err.body) : '';
  const haystack = `${err.message} ${bodyText}`.toLowerCase();
  return [
    /inbox(?:es)?\s+limit/,
    /limit\s+(?:for\s+)?inbox/,
    /max(?:imum)?\s+(?:number\s+of\s+)?inbox/,
    /too many\s+inbox/,
    /quota\s+.*inbox/,
    /inbox.*quota/,
    /upgrade.*inbox/,
  ].some((pattern) => pattern.test(haystack));
}

export function agentMailUpstreamStatus(err: unknown): number | null {
  return err instanceof AgentMailApiError ? err.status : null;
}

async function agentMailRequest<T>(
  apiKey: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENTMAIL_REQUEST_TIMEOUT_MS);
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
    throw new AgentMailApiError({
      message: timedOut
        ? 'AgentMail request timed out'
        : err instanceof Error
          ? err.message
          : 'AgentMail request failed',
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
      typeof data?.message === 'string'
        ? data.message
        : typeof data?.name === 'string'
          ? data.name
          : text || `HTTP ${res.status}`;
    throw new AgentMailApiError({ message: msg, status: res.status, body: data, path });
  }
  return data as T;
}

export async function createAgentMailInbox(input: {
  apiKey: string;
  username?: string | null;
  domain?: string | null;
  displayName?: string | null;
  clientId: string;
  metadata?: Record<string, string | number | boolean>;
}): Promise<AgentMailInbox> {
  const body: Record<string, unknown> = {
    client_id: input.clientId,
    metadata: input.metadata,
  };
  if (input.username) body.username = input.username;
  if (input.domain) body.domain = input.domain;
  if (input.displayName) body.display_name = input.displayName;
  return agentMailRequest<AgentMailInbox>(input.apiKey, '/inboxes', { method: 'POST', body });
}

/** Reply in the thread of `messageId`, as the inbox. */
export async function replyToAgentMailMessage(input: {
  apiKey: string;
  inboxId: string;
  messageId: string;
  text: string;
}): Promise<void> {
  await agentMailRequest(
    input.apiKey,
    `/inboxes/${encodeURIComponent(input.inboxId)}/messages/${encodeURIComponent(input.messageId)}/reply`,
    { method: 'POST', body: { text: input.text } },
  );
}

export async function createAgentMailWebhook(input: {
  apiKey: string;
  inboxId: string;
  url: string;
  clientId: string;
}): Promise<AgentMailWebhook> {
  return agentMailRequest<AgentMailWebhook>(input.apiKey, '/webhooks', {
    method: 'POST',
    body: {
      url: input.url,
      event_types: ['message.received', 'message.received.unauthenticated'],
      inbox_ids: [input.inboxId],
      client_id: input.clientId,
    },
  });
}

// ─── Domains (custom sending/receiving domains on an AgentMail account) ──────

/** AgentMail's own domain: every account can create inboxes on it. */
export const AGENTMAIL_DEFAULT_DOMAIN = 'agentmail.to';

export type AgentMailDomainStatus =
  | 'NOT_STARTED'
  | 'PENDING'
  | 'INVALID'
  | 'FAILED'
  | 'VERIFYING'
  | 'VERIFIED';

export interface AgentMailDnsRecord {
  type: 'TXT' | 'CNAME' | 'MX';
  name: string;
  value: string;
  status: 'MISSING' | 'INVALID' | 'VALID';
  priority?: number;
  reason?: string;
}

export interface AgentMailDomain {
  domain_id: string;
  domain: string;
  status: AgentMailDomainStatus;
  records: AgentMailDnsRecord[];
  reason?: string;
}

export interface AgentMailDomainSetupLink {
  supported: boolean;
  provider_name?: string;
  url?: string;
  conflicting_provider?: string;
}

/** The account's domains, with status and DNS records (the list omits both). */
export async function listAgentMailDomains(apiKey: string): Promise<AgentMailDomain[]> {
  const list = await agentMailRequest<{ domains?: Array<{ domain_id: string }> }>(
    apiKey,
    '/domains?limit=50',
  );
  const ids = (list.domains ?? []).map((d) => d.domain_id).filter(Boolean);
  return Promise.all(ids.map((id) => getAgentMailDomain(apiKey, id)));
}

export async function getAgentMailDomain(apiKey: string, domainId: string): Promise<AgentMailDomain> {
  return agentMailRequest<AgentMailDomain>(apiKey, `/domains/${encodeURIComponent(domainId)}`);
}

export async function createAgentMailDomain(apiKey: string, domain: string): Promise<AgentMailDomain> {
  return agentMailRequest<AgentMailDomain>(apiKey, '/domains', { method: 'POST', body: { domain } });
}

/** Ask AgentMail to re-check the DNS records now, then read the result. */
export async function verifyAgentMailDomain(apiKey: string, domainId: string): Promise<AgentMailDomain> {
  await agentMailRequest(apiKey, `/domains/${encodeURIComponent(domainId)}/verify`, { method: 'POST' });
  return getAgentMailDomain(apiKey, domainId);
}

/** One-click DNS setup (Domain Connect) when the DNS provider supports it. */
export async function getAgentMailDomainSetupLink(
  apiKey: string,
  domainId: string,
): Promise<AgentMailDomainSetupLink> {
  return agentMailRequest<AgentMailDomainSetupLink>(
    apiKey,
    `/domains/${encodeURIComponent(domainId)}/setup-link`,
  );
}

/** AgentMail's own readable reason (`message`, then `fix`) for a refused request. */
export function agentMailRefusal(err: unknown): string | null {
  if (!(err instanceof AgentMailApiError)) return null;
  const body = err.body as { message?: unknown; fix?: unknown; errors?: unknown } | null;
  const parts = [body?.message, body?.fix].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  if (parts.length) return parts.join(' ');
  return err.message || null;
}
