/**
 * Device-code OAuth flows for opencode-style provider auth.
 *
 * Each provider exposes:
 *   - `start*`  — initiates the upstream device-code dance, returns the public
 *                 verification URL + user_code + opaque handle.
 *   - `pollOnce*` — single upstream check; returns 'pending' | 'success'
 *                   | 'failed' so the HTTP route can answer one round-trip
 *                   without holding the connection open. Client drives the
 *                   polling cadence.
 *
 * Ported from:
 *   - opencode/packages/opencode/src/plugin/codex.ts (ChatGPT Pro/Plus headless)
 *   - opencode/packages/opencode/src/plugin/github-copilot/copilot.ts (Copilot)
 *
 * We intentionally do not hold a long-running poll loop server-side — that
 * would tie up a worker and fight reverse-proxy idle timeouts. The flow
 * state (handle + interval + expiry) is owned by oauth-flow-store.ts.
 */

const USER_AGENT = 'kortix-api/oauth-device-flow';

// ─── Shared types ────────────────────────────────────────────────────────────

export interface DeviceFlowStart {
  /** Public URL the user opens in their browser. */
  verification_url: string;
  /** Short code the user types into the verification page. */
  user_code: string;
  /** Polling interval recommended by the upstream (ms). */
  interval_ms: number;
  /** When the device code stops being valid (unix ms). */
  expires_at: number;
  /** Provider-specific opaque handle, passed back to pollOnce. */
  handle: Record<string, unknown>;
}

export type PollOnceResult =
  | { status: 'pending' }
  | { status: 'slow_down'; new_interval_ms: number }
  | {
      status: 'success';
      refresh: string;
      access: string;
      /** Unix ms; 0 means "never expires" (Copilot's behavior). */
      expires: number;
      accountId: string | null;
      enterpriseUrl: string | null;
    }
  | { status: 'failed'; error: string };

// ─── ChatGPT Pro/Plus (Codex) ────────────────────────────────────────────────

const OPENAI_ISSUER = 'https://auth.openai.com';
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_DEVICE_AUTH_URL = `${OPENAI_ISSUER}/api/accounts/deviceauth/usercode`;
const OPENAI_DEVICE_TOKEN_URL = `${OPENAI_ISSUER}/api/accounts/deviceauth/token`;
const OPENAI_OAUTH_TOKEN_URL = `${OPENAI_ISSUER}/oauth/token`;
const OPENAI_DEVICE_REDIRECT_URI = `${OPENAI_ISSUER}/deviceauth/callback`;
const OPENAI_VERIFICATION_URL = `${OPENAI_ISSUER}/codex/device`;

export async function startOpenAiDeviceFlow(): Promise<DeviceFlowStart> {
  const response = await fetch(OPENAI_DEVICE_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ client_id: OPENAI_CLIENT_ID }),
  });
  if (!response.ok) {
    throw new Error(`Failed to initiate OpenAI device authorization: ${response.status}`);
  }
  const data = (await response.json()) as {
    device_auth_id: string;
    user_code: string;
    interval: string;
    expires_in?: number;
  };
  const intervalSec = Math.max(parseInt(data.interval, 10) || 5, 1);
  const expiresInSec = data.expires_in ?? 600;
  return {
    verification_url: OPENAI_VERIFICATION_URL,
    user_code: data.user_code,
    interval_ms: intervalSec * 1000,
    expires_at: Date.now() + expiresInSec * 1000,
    handle: { device_auth_id: data.device_auth_id, user_code: data.user_code },
  };
}

export async function pollOnceOpenAi(handle: Record<string, unknown>): Promise<PollOnceResult> {
  const deviceAuthId = String(handle.device_auth_id ?? '');
  const userCode = String(handle.user_code ?? '');
  if (!deviceAuthId || !userCode) {
    return { status: 'failed', error: 'invalid_handle' };
  }

  const response = await fetch(OPENAI_DEVICE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      device_auth_id: deviceAuthId,
      user_code: userCode,
    }),
  });

  // 403/404 are the upstream's "still pending" signal — anything else
  // non-2xx is terminal failure.
  if (response.status === 403 || response.status === 404) {
    return { status: 'pending' };
  }
  if (!response.ok) {
    return { status: 'failed', error: `upstream_${response.status}` };
  }

  const data = (await response.json()) as {
    authorization_code: string;
    code_verifier: string;
  };

  const tokenResponse = await fetch(OPENAI_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: data.authorization_code,
      redirect_uri: OPENAI_DEVICE_REDIRECT_URI,
      client_id: OPENAI_CLIENT_ID,
      code_verifier: data.code_verifier,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    return { status: 'failed', error: `token_exchange_${tokenResponse.status}` };
  }

  const tokens = (await tokenResponse.json()) as {
    id_token?: string;
    access_token: string;
    refresh_token: string;
    expires_in?: number;
  };

  // accountId comes from JWT claims — prefer id_token (which always carries
  // them), fall back to access_token (also a JWT in this flow).
  const accountId =
    (tokens.id_token && extractOpenAiAccountId(tokens.id_token)) ||
    extractOpenAiAccountId(tokens.access_token);

  return {
    status: 'success',
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId,
    enterpriseUrl: null,
  };
}

function extractOpenAiAccountId(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as {
      chatgpt_account_id?: string;
      organizations?: Array<{ id: string }>;
      'https://api.openai.com/auth'?: { chatgpt_account_id?: string };
    };
    return (
      claims.chatgpt_account_id ||
      claims['https://api.openai.com/auth']?.chatgpt_account_id ||
      claims.organizations?.[0]?.id ||
      null
    );
  } catch {
    return null;
  }
}

// ─── GitHub Copilot ──────────────────────────────────────────────────────────

const GITHUB_COPILOT_CLIENT_ID = 'Ov23li8tweQw6odWQebz';

function normalizeDomain(value: string): string {
  return value.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function githubUrls(domain: string) {
  return {
    deviceCode: `https://${domain}/login/device/code`,
    accessToken: `https://${domain}/login/oauth/access_token`,
  };
}

export interface CopilotStartOptions {
  enterpriseUrl?: string;
}

export async function startCopilotDeviceFlow(opts: CopilotStartOptions = {}): Promise<DeviceFlowStart> {
  const domain = opts.enterpriseUrl ? normalizeDomain(opts.enterpriseUrl) : 'github.com';
  const urls = githubUrls(domain);

  const response = await fetch(urls.deviceCode, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      client_id: GITHUB_COPILOT_CLIENT_ID,
      scope: 'read:user',
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to initiate GitHub Copilot device authorization: ${response.status}`);
  }

  const data = (await response.json()) as {
    verification_uri: string;
    user_code: string;
    device_code: string;
    interval: number;
    expires_in?: number;
  };

  const intervalSec = Math.max(data.interval || 5, 1);
  const expiresInSec = data.expires_in ?? 900;
  const enterpriseUrl = opts.enterpriseUrl ? domain : null;

  return {
    verification_url: data.verification_uri,
    user_code: data.user_code,
    interval_ms: intervalSec * 1000,
    expires_at: Date.now() + expiresInSec * 1000,
    handle: {
      device_code: data.device_code,
      domain,
      enterprise_url: enterpriseUrl,
    },
  };
}

export async function pollOnceCopilot(handle: Record<string, unknown>): Promise<PollOnceResult> {
  const deviceCode = String(handle.device_code ?? '');
  const domain = String(handle.domain ?? 'github.com');
  const enterpriseUrl = (handle.enterprise_url as string | null | undefined) ?? null;
  if (!deviceCode) return { status: 'failed', error: 'invalid_handle' };

  const urls = githubUrls(domain);

  const response = await fetch(urls.accessToken, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      client_id: GITHUB_COPILOT_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });

  if (!response.ok) {
    return { status: 'failed', error: `upstream_${response.status}` };
  }

  const data = (await response.json()) as {
    access_token?: string;
    error?: string;
    interval?: number;
  };

  if (data.access_token) {
    return {
      status: 'success',
      refresh: data.access_token,
      access: data.access_token,
      // GitHub's device-flow access tokens don't expire; opencode stores `0`
      // here to match its plugin behavior.
      expires: 0,
      accountId: null,
      enterpriseUrl,
    };
  }

  if (data.error === 'authorization_pending') {
    return { status: 'pending' };
  }

  if (data.error === 'slow_down') {
    // RFC 8628 §3.5: must add 5s on slow_down. If the server gave us a
    // specific new interval, honor that instead.
    const fallbackMs = 5_000;
    const serverMs = typeof data.interval === 'number' && data.interval > 0
      ? data.interval * 1000
      : null;
    return { status: 'slow_down', new_interval_ms: serverMs ?? fallbackMs };
  }

  return { status: 'failed', error: data.error || 'unknown' };
}
