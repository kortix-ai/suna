import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { accountMembers, accountSecrets } from '@kortix/db';
import type { AppEnv } from '../types';
import { db } from '../shared/db';
import { supabaseAuth } from '../middleware/auth';
import {
  encodeOAuthSubscription,
  encryptAccountSecret,
  type OAuthSubscriptionPayload,
} from './secrets';

// Headless ChatGPT subscription auth via OpenAI's device authorization flow,
// mirroring opencode's `ChatGPT Pro/Plus (headless)` plugin. The user opens
// auth.openai.com/codex/device in any browser and enters a short user_code;
// we poll auth.openai.com for the resulting authorization code, then exchange
// it for tokens. No redirect URI registration required.
const ISSUER = process.env.CHATGPT_OAUTH_ISSUER ?? 'https://auth.openai.com';
const CLIENT_ID = process.env.CHATGPT_OAUTH_CLIENT_ID ?? 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_API_BASE_URL = process.env.CHATGPT_OAUTH_API_BASE_URL
  ?? 'https://chatgpt.com/backend-api/codex';
const CHATGPT_SECRET_NAME = 'CHATGPT_SUBSCRIPTION';
const ORIGINATOR = process.env.CHATGPT_OAUTH_ORIGINATOR ?? 'kortix';

type DeviceAuthInit = {
  device_auth_id: string;
  user_code: string;
  interval: string;
};

type DeviceAuthTokenResponse = {
  authorization_code: string;
  code_verifier: string;
};

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in?: number;
};

type IdTokenClaims = {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  email?: string;
  'https://api.openai.com/auth'?: { chatgpt_account_id?: string };
};

function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as IdTokenClaims;
  } catch {
    return undefined;
  }
}

function extractAccountId(tokens: TokenResponse): string | undefined {
  const fromId = tokens.id_token ? parseJwtClaims(tokens.id_token) : undefined;
  const fromAccess = tokens.access_token ? parseJwtClaims(tokens.access_token) : undefined;
  const pick = (c: IdTokenClaims | undefined): string | undefined =>
    c
      ? c.chatgpt_account_id
        ?? c['https://api.openai.com/auth']?.chatgpt_account_id
        ?? c.organizations?.[0]?.id
      : undefined;
  return pick(fromId) ?? pick(fromAccess);
}

// Per-ticket flow state. Held in memory with a 15-min TTL — that's well past
// the device flow's typical user_code lifetime. Multi-instance API deployments
// would need to move this to the DB (or use sticky sessions).
type PendingFlow = {
  userId: string;
  accountId: string;
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  createdAt: number;
  // Last time we polled deviceauth/token, so we can rate-limit polls.
  lastPollAt: number;
};
const PENDING_FLOWS = new Map<string, PendingFlow>();
const PENDING_TTL_MS = 15 * 60_000;

setInterval(() => {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [ticket, flow] of PENDING_FLOWS) {
    if (flow.createdAt < cutoff) PENDING_FLOWS.delete(ticket);
  }
}, 60_000).unref?.();

async function fetchDeviceAuth(): Promise<DeviceAuthInit> {
  const res = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': `kortix/oauth-chatgpt`,
    },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`deviceauth/usercode failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<DeviceAuthInit>;
}

async function fetchDeviceAuthToken(flow: PendingFlow): Promise<
  | { status: 'pending' }
  | { status: 'ready'; auth: DeviceAuthTokenResponse }
  | { status: 'failed'; code: number; detail: string }
> {
  const res = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': `kortix/oauth-chatgpt`,
    },
    body: JSON.stringify({
      device_auth_id: flow.deviceAuthId,
      user_code: flow.userCode,
    }),
  });
  if (res.ok) {
    return { status: 'ready', auth: await res.json() as DeviceAuthTokenResponse };
  }
  if (res.status === 403 || res.status === 404) {
    return { status: 'pending' };
  }
  const detail = await res.text().catch(() => '');
  return { status: 'failed', code: res.status, detail: detail.slice(0, 200) };
}

async function exchangeAuthorizationCode(auth: DeviceAuthTokenResponse): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: auth.authorization_code,
    redirect_uri: `${ISSUER}/deviceauth/callback`,
    client_id: CLIENT_ID,
    code_verifier: auth.code_verifier,
  });
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`oauth/token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<TokenResponse>;
}

async function persistSubscription(input: {
  accountId: string;
  userId: string;
  tokens: TokenResponse;
}): Promise<OAuthSubscriptionPayload> {
  const accountIdExternal = extractAccountId(input.tokens);
  const payload: OAuthSubscriptionPayload = {
    provider: 'chatgpt',
    access_token: input.tokens.access_token,
    refresh_token: input.tokens.refresh_token,
    expires_at: new Date(Date.now() + (input.tokens.expires_in ?? 3600) * 1000).toISOString(),
    ...(input.tokens.id_token ? { id_token: input.tokens.id_token } : {}),
    ...(accountIdExternal ? { account_id_external: accountIdExternal } : {}),
  };

  const now = new Date();
  await db
    .insert(accountSecrets)
    .values({
      accountId: input.accountId,
      name: CHATGPT_SECRET_NAME,
      valueEnc: encryptAccountSecret(input.accountId, encodeOAuthSubscription(payload)),
      kind: 'oauth_subscription',
      provider: 'chatgpt',
      createdBy: input.userId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [accountSecrets.accountId, accountSecrets.name],
      set: {
        valueEnc: encryptAccountSecret(input.accountId, encodeOAuthSubscription(payload)),
        kind: 'oauth_subscription',
        provider: 'chatgpt',
        updatedAt: now,
      },
    });

  return payload;
}

export const oauthChatgptRouter = new Hono<AppEnv>();

// POST /v1/oauth/chatgpt/start
// Body: { account_id }. Returns the user_code the user types into the browser,
// the verification URL, and a ticket the client uses to /poll. We never see
// the user's ChatGPT credentials.
oauthChatgptRouter.post('/start', supabaseAuth, async (c) => {
  const userId = c.get('userId') as string;
  let body: Record<string, unknown> = {};
  try { body = (await c.req.json()) ?? {}; } catch { body = {}; }
  const accountId = typeof body.account_id === 'string' ? body.account_id : null;
  if (!accountId) return c.json({ error: 'account_id is required' }, 400);

  const [membership] = await db
    .select({ accountRole: accountMembers.accountRole })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);
  if (membership.accountRole !== 'owner' && membership.accountRole !== 'admin') {
    return c.json({ error: 'Owner or admin role required' }, 403);
  }

  let deviceAuth: DeviceAuthInit;
  try {
    deviceAuth = await fetchDeviceAuth();
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }

  const ticket = randomBytes(24).toString('base64url');
  const intervalMs = Math.max(parseInt(deviceAuth.interval, 10) || 5, 1) * 1000;
  PENDING_FLOWS.set(ticket, {
    userId,
    accountId,
    deviceAuthId: deviceAuth.device_auth_id,
    userCode: deviceAuth.user_code,
    intervalMs,
    createdAt: Date.now(),
    lastPollAt: 0,
  });

  return c.json({
    ticket,
    user_code: deviceAuth.user_code,
    verification_url: `${ISSUER}/codex/device`,
    poll_interval_ms: intervalMs,
    originator: ORIGINATOR,
  });
});

// POST /v1/oauth/chatgpt/poll
// Body: { ticket }. Single deviceauth/token attempt per call. Returns
// { status: 'pending' } until the user finishes consent in their browser,
// then { status: 'ready' } once tokens are exchanged and persisted.
oauthChatgptRouter.post('/poll', supabaseAuth, async (c) => {
  const userId = c.get('userId') as string;
  let body: Record<string, unknown> = {};
  try { body = (await c.req.json()) ?? {}; } catch { body = {}; }
  const ticket = typeof body.ticket === 'string' ? body.ticket : null;
  if (!ticket) return c.json({ error: 'ticket is required' }, 400);

  const flow = PENDING_FLOWS.get(ticket);
  if (!flow) return c.json({ status: 'expired' }, 410);
  if (flow.userId !== userId) return c.json({ error: 'Forbidden' }, 403);
  if (Date.now() - flow.createdAt > PENDING_TTL_MS) {
    PENDING_FLOWS.delete(ticket);
    return c.json({ status: 'expired' }, 410);
  }
  if (Date.now() - flow.lastPollAt < flow.intervalMs) {
    return c.json({ status: 'pending', retry_after_ms: flow.intervalMs });
  }
  flow.lastPollAt = Date.now();

  const result = await fetchDeviceAuthToken(flow);
  if (result.status === 'pending') {
    return c.json({ status: 'pending', retry_after_ms: flow.intervalMs });
  }
  if (result.status === 'failed') {
    PENDING_FLOWS.delete(ticket);
    return c.json(
      { status: 'failed', error: `deviceauth/token returned ${result.code}: ${result.detail}` },
      502,
    );
  }

  let tokens: TokenResponse;
  try {
    tokens = await exchangeAuthorizationCode(result.auth);
  } catch (err) {
    PENDING_FLOWS.delete(ticket);
    return c.json({ status: 'failed', error: (err as Error).message }, 502);
  }

  PENDING_FLOWS.delete(ticket);
  const payload = await persistSubscription({
    accountId: flow.accountId,
    userId: flow.userId,
    tokens,
  });

  return c.json({
    status: 'ready',
    account_id: flow.accountId,
    expires_at: payload.expires_at,
    account_id_external: payload.account_id_external ?? null,
  });
});

// Refresh an oauth_subscription's access_token JIT before injection. Called
// from session boot when expires_at is within REFRESH_SKEW_MS.
const REFRESH_SKEW_MS = 5 * 60_000;

export async function refreshChatgptSubscriptionIfNeeded(input: {
  accountId: string;
  current: OAuthSubscriptionPayload;
}): Promise<OAuthSubscriptionPayload> {
  const expiresAtMs = Date.parse(input.current.expires_at);
  if (Number.isFinite(expiresAtMs) && expiresAtMs - Date.now() > REFRESH_SKEW_MS) {
    return input.current;
  }

  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: input.current.refresh_token,
      client_id: CLIENT_ID,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ChatGPT refresh failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const tokens = await res.json() as TokenResponse;
  if (!tokens.access_token) {
    throw new Error('ChatGPT refresh: response missing access_token');
  }

  const refreshed: OAuthSubscriptionPayload = {
    provider: 'chatgpt',
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? input.current.refresh_token,
    expires_at: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
    ...(tokens.id_token ? { id_token: tokens.id_token } : {}),
    account_id_external: extractAccountId(tokens) ?? input.current.account_id_external,
  };

  await db
    .update(accountSecrets)
    .set({
      valueEnc: encryptAccountSecret(input.accountId, encodeOAuthSubscription(refreshed)),
      updatedAt: new Date(),
    })
    .where(and(
      eq(accountSecrets.accountId, input.accountId),
      eq(accountSecrets.name, CHATGPT_SECRET_NAME),
    ));

  return refreshed;
}

// Maps a fresh ChatGPT subscription into the env vars the sandbox needs to
// route OpenAI SDK calls through chatgpt.com/backend-api/codex. The
// ChatGPT-Account-Id header (required for org subscriptions in opencode's
// plugin) can't ride an env var into the standard OpenAI SDK — downstream
// code that needs it should read CHATGPT_ACCOUNT_ID and set the header
// explicitly (or use a thin wrapper / proxy).
export function chatgptSubscriptionEnv(payload: OAuthSubscriptionPayload): Record<string, string> {
  return {
    OPENAI_API_KEY: payload.access_token,
    OPENAI_BASE_URL: CODEX_API_BASE_URL,
    ...(payload.account_id_external
      ? { CHATGPT_ACCOUNT_ID: payload.account_id_external }
      : {}),
  };
}
