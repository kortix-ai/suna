// OAuth 2.1 PKCE + dynamic client registration (protocol.md §1).
import { DEFAULT_API_URL } from './types';
import { clearStored, getStored, setStored } from './state';

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  return { verifier, challenge, state };
}

export const normalizeApiUrl = (u: string) => {
  const url = new URL(u.trim());
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('The server address must start with https://');
  }
  return url.origin;
};

type Meta = { authorization_endpoint: string; token_endpoint: string; registration_endpoint: string };
const meta = async (api: string): Promise<Meta> => {
  const r = await fetch(`${api}/.well-known/oauth-authorization-server`);
  if (!r.ok) throw new Error(`Cannot reach ${api} (${r.status})`);
  return r.json();
};

const form = (o: Record<string, string>) => new URLSearchParams(o);
type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number };
async function saveTokens(t: TokenResponse, prevRefresh?: string) {
  await setStored({
    token: t.access_token,
    refreshToken: t.refresh_token ?? prevRefresh,
    expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined,
  });
}

/** Interactive sign-in. Stores the API URL, client and tokens. */
export async function signIn(apiUrl?: string): Promise<void> {
  const api = normalizeApiUrl(apiUrl || (await getStored()).apiUrl || DEFAULT_API_URL);
  const m = await meta(api);
  const redirectUri = chrome.identity.getRedirectURL();
  let { clientId, clientApi, redirectUri: regRedirect } = await getStored();
  if (!clientId || clientApi !== api || regRedirect !== redirectUri) {
    const r = await fetch(m.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Kortix for Chrome',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'kortix',
      }),
    });
    if (!r.ok) throw new Error(`Sign-in is not available on ${api} (${r.status})`);
    clientId = (await r.json()).client_id as string;
    await setStored({ clientId, clientApi: api, redirectUri });
  }
  const { verifier, challenge, state } = await pkce();
  const url = new URL(m.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'kortix', state,
    code_challenge: challenge, code_challenge_method: 'S256',
  })) url.searchParams.set(k, v);
  const done = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true });
  const back = new URL(done ?? '');
  if (back.searchParams.get('state') !== state) throw new Error('Sign-in was interrupted. Try again.');
  const code = back.searchParams.get('code');
  if (!code) throw new Error(back.searchParams.get('error_description') || 'Sign-in was canceled.');
  const r = await fetch(m.token_endpoint, {
    method: 'POST',
    body: form({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
  });
  if (!r.ok) throw new Error(`Sign-in failed (${r.status})`);
  await setStored({ apiUrl: api });
  await saveTokens(await r.json());
}

let refreshing: Promise<string | undefined> | undefined;

/** A valid access token, refreshed when it expires in under 5 minutes. */
export async function getToken(force = false): Promise<string | undefined> {
  const s = await getStored();
  if (!s.token) return undefined;
  // No expiresAt = a token that does not expire (tests, API keys).
  if (!force && (!s.expiresAt || s.expiresAt - Date.now() > 5 * 60_000)) return s.token;
  if (!s.refreshToken || !s.clientId || !s.apiUrl) return force || (s.expiresAt ?? 0) < Date.now() ? undefined : s.token;
  refreshing ??= (async () => {
    try {
      const m = await meta(s.apiUrl!);
      const r = await fetch(m.token_endpoint, {
        method: 'POST',
        body: form({ grant_type: 'refresh_token', refresh_token: s.refreshToken!, client_id: s.clientId! }),
      });
      if (!r.ok) {
        // 4xx = the refresh token is dead: signed out. 5xx = try again later.
        if (r.status < 500) await signOutLocal();
        return undefined;
      }
      await saveTokens(await r.json(), s.refreshToken);
      return (await getStored()).token;
    } catch {
      return undefined; // offline: keep the old token, the caller retries
    } finally {
      refreshing = undefined;
    }
  })();
  return refreshing;
}

export const signOutLocal = () =>
  clearStored(['token', 'refreshToken', 'expiresAt', 'browser', 'webUrl']);
