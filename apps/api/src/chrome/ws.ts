/**
 * The control socket of the Kortix for Chrome extension: `wss://<api>/v1/chrome/ws`.
 *
 * The upgrade carries no credential. The first frame is `auth` with a
 * `kortix_oat_` token (scope `kortix`) or a user `kortix_pat_` token, and it
 * must arrive within 10 s. There is no Origin check: the token is the gate.
 */
import { API_INSTANCE_ID } from '../shared/instance';
import { clientKeyFromHeaders } from '../shared/client-ip';
import { isOAuthAccessToken, OAUTH_SCOPE_KORTIX, validateOAuthAccessToken } from '../oauth/access-token';
import { isAccountToken } from '../shared/crypto';
import { validateAccountToken } from '../repositories/account-tokens';
import { resolveAccountId } from '../shared/resolve-account';
import { tunnelRateLimiter } from '../tunnel/core/rate-limiter';
import { toChromeDto } from './logic';
import { registerSocket, unregisterSocket, type ChromeSocket } from './registry';
import { handleAttached, handleConsent, handleDetached } from './service';
import { activeSessionsFor, markOffline, touchChrome, upsertConnection, type ChromeInfo } from './store';
import { config } from '../config';
import { logger } from '../lib/logger';
import { isUuid } from '../shared/validate';

export const CHROME_AUTH_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 64 * 1024;
const BAD_TOKEN = 4001;

export interface ChromeWsData {
  type: 'chrome-extension';
  authTimer?: ReturnType<typeof setTimeout>;
  chromeId?: string;
}

type Socket = ChromeSocket & { data: ChromeWsData };

/** Rate-limit the upgrade by client address. Returns the socket data, or a refusal. */
export function prepareChromeUpgrade(
  headers: Headers,
): { ok: true; data: ChromeWsData } | { ok: false; status: number; message: string } {
  const client = clientKeyFromHeaders((name) => headers.get(name));
  const check = tunnelRateLimiter.check('wsConnectIp', `chrome:${client}`);
  if (!check.allowed) return { ok: false, status: 429, message: 'Too many connection attempts' };
  return { ok: true, data: { type: 'chrome-extension' } };
}

export const chromeWsHandlers = {
  open(ws: Socket) {
    ws.data.authTimer = setTimeout(() => safeClose(ws, BAD_TOKEN, 'auth timeout'), CHROME_AUTH_TIMEOUT_MS);
  },

  message(ws: Socket, raw: string | Buffer) {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    if (text.length > MAX_FRAME_BYTES) return safeClose(ws, 1009, 'frame too large');
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    if (!ws.data.chromeId) {
      if (frame.type === 'auth') void authenticate(ws, frame);
      else safeClose(ws, BAD_TOKEN, 'auth required');
      return;
    }
    void routeFrame(ws, ws.data.chromeId, frame).catch((err) => {
      logger.error('[chrome-ws] frame failed', { error: err instanceof Error ? err.message : String(err) });
    });
  },

  close(ws: Socket) {
    if (ws.data.authTimer) clearTimeout(ws.data.authTimer);
    const chromeId = ws.data.chromeId;
    if (chromeId && unregisterSocket(chromeId, ws)) {
      void markOffline(chromeId, API_INSTANCE_ID).catch((err) => {
        logger.warn('[chrome-ws] mark offline failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }
  },
};

function safeClose(ws: ChromeSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}

// ── Auth ────────────────────────────────────────────────────────────────────

interface Principal {
  userId: string;
  accountId: string;
}

/** A `kortix_oat_` token with the `kortix` scope, or a PAT that is not session-scoped. */
async function resolvePrincipal(token: string): Promise<Principal | null> {
  if (isOAuthAccessToken(token)) {
    const r = await validateOAuthAccessToken(token);
    if (!r.isValid || !r.userId || !r.scopes?.includes(OAUTH_SCOPE_KORTIX)) return null;
    return { userId: r.userId, accountId: r.accountId ?? (await resolveAccountId(r.userId)) };
  }
  if (isAccountToken(token)) {
    const r = await validateAccountToken(token);
    if (!r.isValid || !r.userId || r.sessionId) return null;
    return { userId: r.userId, accountId: r.accountId ?? (await resolveAccountId(r.userId)) };
  }
  return null;
}

function readInfo(raw: unknown): ChromeInfo {
  const info = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : fallback);
  const optional = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);
  return {
    brand: text(info.brand, 'Chrome'),
    os: text(info.os, 'Unknown'),
    profileLabel: optional(info.profileLabel),
    extensionVersion: optional(info.extensionVersion),
  };
}

async function authenticate(ws: Socket, frame: Record<string, unknown>): Promise<void> {
  const token = typeof frame.token === 'string' ? frame.token : '';
  let principal: Principal | null;
  try {
    principal = token ? await resolvePrincipal(token) : null;
  } catch (err) {
    logger.error('[chrome-ws] auth failed', { error: err instanceof Error ? err.message : String(err) });
    return safeClose(ws, 1011, 'auth unavailable');
  }
  if (!principal) return safeClose(ws, BAD_TOKEN, 'bad token');
  if (ws.data.chromeId) return;

  const requested = typeof frame.chromeId === 'string' ? frame.chromeId : null;
  const row = await upsertConnection({
    userId: principal.userId,
    accountId: principal.accountId,
    chromeId: requested,
    info: readInfo(frame.info),
    relayOwnerId: API_INSTANCE_ID,
  });
  if (ws.data.authTimer) clearTimeout(ws.data.authTimer);
  ws.data.chromeId = row.chromeId;
  registerSocket(row.chromeId, ws);
  const sessions = await activeSessionsFor([row.chromeId]);
  ws.send(
    JSON.stringify({
      type: 'auth_ok',
      chrome: toChromeDto(row, sessions.get(row.chromeId) ?? []),
      webUrl: config.FRONTEND_URL,
    }),
  );
}

// ── Frames after auth ───────────────────────────────────────────────────────

async function routeFrame(ws: Socket, chromeId: string, frame: Record<string, unknown>): Promise<void> {
  const attachmentId = typeof frame.attachmentId === 'string' ? frame.attachmentId : '';
  if (frame.type !== 'ping' && !isUuid(attachmentId)) return;
  switch (frame.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      await touchChrome(chromeId, API_INSTANCE_ID);
      return;
    case 'consent':
      return handleConsent(chromeId, attachmentId, frame.decision);
    case 'attached':
      return handleAttached(chromeId, attachmentId);
    case 'detached':
      return handleDetached(chromeId, attachmentId, frame.reason);
  }
}
