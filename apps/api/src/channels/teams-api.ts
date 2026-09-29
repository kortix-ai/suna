import { config } from '../config';
import { loadTeamsBotCredentials, loadTeamsServiceUrlForProject } from './install-store';
import { botConnectorToken } from './teams-auth';
import { assertValidTeamsServiceUrl } from './teams-service-url';
import type { TeamsConversationRef } from './teams/types';

const ADAPTIVE_CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';

export interface OutboundActivity {
  type: 'message' | 'typing';
  text?: string;
  attachments?: Array<{ contentType: string; content?: unknown; name?: string; contentUrl?: string }>;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function connectorFetch(
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  body: unknown,
  projectId?: string,
): Promise<{ ok: boolean; status: number; id: string | null; error?: string }> {
  // Defense-in-depth chokepoint: the bot connector token is attached below, so
  // the destination URL MUST be a validated Microsoft Bot Framework endpoint.
  // This blocks any caller (incl. a future one) from leaking the token to an
  // attacker-controlled host. See F-7.
  if (!assertValidTeamsServiceUrl(url)) {
    console.warn('[teams-api] blocked outbound connector call to untrusted serviceUrl', {
      method,
      host: (() => {
        try {
          return new URL(url).hostname;
        } catch {
          return '<invalid>';
        }
      })(),
    });
    return { ok: false, status: 0, id: null, error: 'untrusted service url' };
  }
  try {
    const creds = projectId ? await loadTeamsBotCredentials(projectId) : null;
    const token = await botConnectorToken(creds);
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
  const r = await connectorFetch('POST', url, activity, ref.projectId);
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
  const r = await connectorFetch('PUT', url, activity, ref.projectId);
  return r.ok;
}

/** Delete a message the bot posted. Bot Framework refuses anyone else's. */
export async function deleteActivity(ref: TeamsConversationRef, activityId: string): Promise<boolean> {
  const url = joinUrl(
    ref.serviceUrl,
    `v3/conversations/${encodeURIComponent(ref.conversationId)}/activities/${encodeURIComponent(activityId)}`,
  );
  return (await connectorFetch('DELETE', url, undefined, ref.projectId)).ok;
}

/**
 * The one-to-one chat between the bot and a Teams user (their AAD object id),
 * for a message that does not answer anything they sent there: an admin's
 * access-request notice, the "connected" confirmation, a sign-in link asked
 * for in a channel. Teams opens it only when the user has the app installed
 * for themselves. Measured on dev 2026-09-29: otherwise `403 Bot is not
 * installed in user's personal scope`. So null is an expected answer, and
 * every caller keeps a fallback.
 */
export async function openDirectConversation(input: {
  projectId: string;
  tenantId: string;
  userId: string;
}): Promise<TeamsConversationRef | null> {
  const serviceUrl = await loadTeamsServiceUrlForProject(input.projectId);
  if (!serviceUrl) return null;
  const appId = (await loadTeamsBotCredentials(input.projectId))?.appId ?? config.MICROSOFT_APP_ID;
  if (!appId) return null;
  const botId = `28:${appId}`;
  const r = await connectorFetch('POST', joinUrl(serviceUrl, 'v3/conversations'), {
    isGroup: false,
    bot: { id: botId },
    members: [{ id: input.userId }],
    tenantId: input.tenantId,
    channelData: { tenant: { id: input.tenantId } },
  }, input.projectId);
  if (!r.ok || !r.id) return null;
  return { serviceUrl, conversationId: r.id, botId, tenantId: input.tenantId, projectId: input.projectId };
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
