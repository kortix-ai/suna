// OpenAI Codex (ChatGPT Plus/Pro) OAuth device grant — driven directly with
// plain HTTPS calls to auth.openai.com. No subprocess, no OpenCode `serve`, no
// pinned pod: `start` requests a device code, `poll` exchanges it once the user
// authorizes in the browser. The resulting auth.json is exactly what the
// sandbox materializes for OpenCode:
//
//   { "openai": { "type":"oauth", "access", "refresh", "expires", "accountId" } }
//
// Protocol (mirrors the Codex CLI / OpenCode client so OpenAI accepts it):
//   1. POST /api/accounts/deviceauth/usercode {client_id} → {device_auth_id, user_code, interval}
//   2. poll POST /api/accounts/deviceauth/token {device_auth_id, user_code}
//        → 403/404 while pending; 200 → {authorization_code, code_verifier}
//   3. POST /oauth/token (authorization_code grant, with the server-issued PKCE
//        code_verifier) → {access_token, refresh_token, expires_in, id_token}

const OPENAI_AUTH_BASE = 'https://auth.openai.com';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
// OpenAI ties acceptance to the Codex client; present as that client.
const USER_AGENT = 'opencode/1.14.28';
const REDIRECT_URI = `${OPENAI_AUTH_BASE}/deviceauth/callback`;

export type CodexDeviceChallenge = {
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  intervalMs: number;
};

export type CodexPollResult =
  | { status: 'pending' }
  | { status: 'failed'; error: string }
  | { status: 'authorized'; authJson: string };

/** Step 1 — request a device code. Returns the user code + the id to poll with. */
export async function startCodexDeviceAuth(): Promise<CodexDeviceChallenge> {
  const res = await fetch(`${OPENAI_AUTH_BASE}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });
  if (!res.ok) {
    throw new Error(`Failed to start ChatGPT device authorization (${res.status})`);
  }
  const data = (await res.json()) as {
    device_auth_id?: string;
    user_code?: string;
    interval?: number | string;
  };
  if (!data.device_auth_id || !data.user_code) {
    throw new Error('OpenAI did not return a device code');
  }
  return {
    verificationUrl: `${OPENAI_AUTH_BASE}/codex/device`,
    userCode: data.user_code,
    deviceAuthId: data.device_auth_id,
    intervalMs: Math.max(Number.parseInt(String(data.interval ?? 5), 10) || 5, 1) * 1000,
  };
}

/** Steps 2 + 3 — one poll tick: still pending, failed, or fully authorized. */
export async function pollCodexDeviceAuth(input: {
  deviceAuthId: string;
  userCode: string;
}): Promise<CodexPollResult> {
  const res = await fetch(`${OPENAI_AUTH_BASE}/api/accounts/deviceauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ device_auth_id: input.deviceAuthId, user_code: input.userCode }),
  });
  // The user hasn't finished authorizing in the browser yet.
  if (res.status === 403 || res.status === 404) return { status: 'pending' };
  if (!res.ok) return { status: 'failed', error: `Authorization failed (${res.status})` };

  const granted = (await res.json()) as { authorization_code?: string; code_verifier?: string };
  if (!granted.authorization_code || !granted.code_verifier) {
    return { status: 'failed', error: 'OpenAI returned an incomplete authorization' };
  }

  const tokenRes = await fetch(`${OPENAI_AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: granted.authorization_code,
      redirect_uri: REDIRECT_URI,
      client_id: CODEX_CLIENT_ID,
      code_verifier: granted.code_verifier,
    }).toString(),
  });
  if (!tokenRes.ok) {
    return { status: 'failed', error: `Token exchange failed (${tokenRes.status})` };
  }
  const tokens = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
  };
  if (!tokens.access_token || !tokens.refresh_token) {
    return { status: 'failed', error: 'OpenAI did not return tokens' };
  }

  const auth: Record<string, unknown> = {
    type: 'oauth',
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
  const accountId = extractAccountId(tokens);
  if (accountId) auth.accountId = accountId;

  return { status: 'authorized', authJson: JSON.stringify({ openai: auth }, null, 2) };
}

// ── accountId: the chatgpt_account_id claim from the id_token (or access_token) ──

function jwtClaims(jwt: string): Record<string, any> | undefined {
  const parts = jwt.split('.');
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

function accountIdFromClaims(claims: Record<string, any> | undefined): string | undefined {
  if (!claims) return undefined;
  return (
    claims.chatgpt_account_id ??
    claims['https://api.openai.com/auth']?.chatgpt_account_id ??
    claims.organizations?.[0]?.id
  );
}

function extractAccountId(tokens: { id_token?: string; access_token?: string }): string | undefined {
  if (tokens.id_token) {
    const id = accountIdFromClaims(jwtClaims(tokens.id_token));
    if (id) return id;
  }
  if (tokens.access_token) return accountIdFromClaims(jwtClaims(tokens.access_token));
  return undefined;
}
