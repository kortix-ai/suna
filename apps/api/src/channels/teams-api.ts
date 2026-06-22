import { botConnectorToken } from './teams-auth';
import type { TeamsConversationRef } from './teams/types';

const ADAPTIVE_CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';

export interface OutboundActivity {
  type: 'message' | 'typing';
  text?: string;
  attachments?: Array<{ contentType: string; content: unknown }>;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function connectorFetch(
  method: 'POST' | 'PUT',
  url: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; id: string | null; error?: string }> {
  try {
    const token = await botConnectorToken();
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let id: string | null = null;
    try {
      id = (JSON.parse(text) as { id?: string }).id ?? null;
    } catch {
    }
    if (!res.ok) {
      console.warn('[teams-api] connector call failed', { method, status: res.status, body: text.slice(0, 200) });
      return { ok: false, status: res.status, id: null, error: text.slice(0, 200) };
    }
    return { ok: true, status: res.status, id };
  } catch (err) {
    console.warn('[teams-api] connector call error', { method, err: (err as Error)?.message });
    return { ok: false, status: 0, id: null, error: (err as Error)?.message };
  }
}

export function cardActivity(card: unknown): OutboundActivity {
  return {
    type: 'message',
    attachments: [{ contentType: ADAPTIVE_CARD_CONTENT_TYPE, content: card }],
  };
}

export async function sendActivity(ref: TeamsConversationRef, activity: OutboundActivity): Promise<string | null> {
  const url = joinUrl(ref.serviceUrl, `v3/conversations/${encodeURIComponent(ref.conversationId)}/activities`);
  const r = await connectorFetch('POST', url, activity);
  return r.ok ? r.id : null;
}

export async function updateActivity(
  ref: TeamsConversationRef,
  activityId: string,
  activity: OutboundActivity,
): Promise<boolean> {
  const url = joinUrl(
    ref.serviceUrl,
    `v3/conversations/${encodeURIComponent(ref.conversationId)}/activities/${encodeURIComponent(activityId)}`,
  );
  const r = await connectorFetch('PUT', url, activity);
  return r.ok;
}

export function sendText(ref: TeamsConversationRef, text: string): Promise<string | null> {
  return sendActivity(ref, { type: 'message', text });
}

export function sendCard(ref: TeamsConversationRef, card: unknown): Promise<string | null> {
  return sendActivity(ref, cardActivity(card));
}

export function updateCard(ref: TeamsConversationRef, activityId: string, card: unknown): Promise<boolean> {
  return updateActivity(ref, activityId, cardActivity(card));
}

export async function sendTyping(ref: TeamsConversationRef): Promise<void> {
  await sendActivity(ref, { type: 'typing' }).catch(() => null);
}
