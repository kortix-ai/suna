import { sharedConfig as config, sharedFetch } from '../shared/effect';

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
    typeof err.body === 'string'
      ? err.body
      : err.body
        ? JSON.stringify(err.body)
        : '';
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
  let res: Response;
  try {
    res = await sharedFetch(`${baseUrl()}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(AGENTMAIL_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
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
    const msg = typeof data?.message === 'string'
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
