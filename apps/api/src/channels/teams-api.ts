import { config } from '../lib/config';
import { loadTeamsBotCredentials, loadTeamsServiceUrlForProject } from './install-store';
import { botConnectorToken } from './teams-auth';
import { assertValidTeamsServiceUrl } from './teams-service-url';
import type { TeamsConversationRef } from './teams/types';

const ADAPTIVE_CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';

export interface OutboundActivity {
  type: 'message' | 'typing';
  text?: string;
  attachments?: Array<{ contentType: string; content?: unknown; name?: string; contentUrl?: string }>;
  /** The one person a targeted message is for. */
  recipient?: { id: string };
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function connectorFetch(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body: unknown,
  projectId?: string,
): Promise<{ ok: boolean; status: number; id: string | null; json?: unknown; error?: string }> {
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
    let json: unknown;
    try {
      json = JSON.parse(text);
      id = (json as { id?: string } | null)?.id ?? null;
    } catch {
    }
    if (!res.ok) {
      console.warn('[teams-api] connector call failed', { method, status: res.status, body: text.slice(0, 200) });
      return { ok: false, status: res.status, id: null, error: text.slice(0, 200) };
    }
    return { ok: true, status: res.status, id, json };
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

/**
 * A card in a channel or group chat that only `recipientId` (a `29:…` Teams
 * user id of a member there) sees: a Teams targeted message, marked "Only you
 * can see this message" — Slack's ephemeral. GA since 2026-07-30; Teams
 * deletes it after 24 hours. Null when Teams refuses it (for example
 * `403 BotNotInConversationRoster`, or a recipient who left), so every caller
 * keeps a fallback.
 */
export async function sendTargetedCard(ref: TeamsConversationRef, recipientId: string, card: unknown): Promise<string | null> {
  const url = joinUrl(
    ref.serviceUrl,
    `v3/conversations/${encodeURIComponent(ref.conversationId)}/activities?isTargetedActivity=true`,
  );
  const r = await connectorFetch('POST', url, { ...cardActivity(card), recipient: { id: recipientId } }, ref.projectId);
  return r.ok ? r.id : null;
}

/**
 * The Teams user id (`29:…`) of the member of `ref`'s conversation whose
 * Entra object id is `aadObjectId` — the id a targeted message needs, when
 * only the object id was stored. Null when Teams does not know them there.
 */
export async function conversationMemberId(ref: TeamsConversationRef, aadObjectId: string): Promise<string | null> {
  // A channel thread is `19:…@thread.tacv2;messageid=…`; its members are the channel's.
  const conversationId = ref.conversationId.split(';')[0] ?? ref.conversationId;
  const url = joinUrl(
    ref.serviceUrl,
    `v3/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(aadObjectId)}`,
  );
  const r = await connectorFetch('GET', url, undefined, ref.projectId);
  return r.ok ? r.id : null;
}

/**
 * A team by its id (`19:…@thread.tacv2`, the General channel's id). Null when
 * the id is not a team the bot is in, or on any failure.
 */
export async function getTeamsTeam(
  serviceUrl: string,
  teamId: string,
  projectId?: string,
): Promise<{ id: string; name: string } | null> {
  const r = await connectorFetch('GET', joinUrl(serviceUrl, `v3/teams/${encodeURIComponent(teamId)}`), undefined, projectId);
  const team = r.ok ? (r.json as { id?: unknown; name?: unknown } | undefined) : undefined;
  return typeof team?.id === 'string' && typeof team.name === 'string' && team.name.trim()
    ? { id: team.id, name: team.name.trim() }
    : null;
}

/** A team's channels. The General channel has no `name`. Null on any failure. */
export async function listTeamsTeamChannels(
  serviceUrl: string,
  teamId: string,
  projectId?: string,
): Promise<Array<{ id: string; name: string | null }> | null> {
  const r = await connectorFetch(
    'GET',
    joinUrl(serviceUrl, `v3/teams/${encodeURIComponent(teamId)}/conversations`),
    undefined,
    projectId,
  );
  const list = r.ok ? (r.json as { conversations?: unknown } | undefined)?.conversations : undefined;
  if (!Array.isArray(list)) return null;
  return list.flatMap((c: { id?: unknown; name?: unknown }) =>
    typeof c?.id === 'string'
      ? [{ id: c.id, name: typeof c.name === 'string' && c.name.trim() ? c.name.trim() : null }]
      : [],
  );
}

export function updateCard(ref: TeamsConversationRef, activityId: string, card: unknown): Promise<boolean> {
  return updateActivity(ref, activityId, cardActivity(card));
}

export async function sendTyping(ref: TeamsConversationRef): Promise<void> {
  await sendActivity(ref, { type: 'typing' }).catch(() => null);
}
