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

function baseUrl(): string {
  return (config.AGENTMAIL_API_URL || 'https://api.agentmail.to/v0').replace(/\/+$/, '');
}

export function resolveAgentMailApiKey(projectKey?: string | null): string | null {
  return projectKey || config.AGENTMAIL_API_KEY || null;
}

async function agentMailRequest<T>(
  apiKey: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
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
    throw new Error(msg);
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
      event_types: ['message.received'],
      inbox_ids: [input.inboxId],
      client_id: input.clientId,
    },
  });
}
