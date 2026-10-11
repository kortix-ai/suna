export type CallbackTokens = { access_token: string; refresh_token: string };

function tokensFrom(params: URLSearchParams): CallbackTokens | null {
  const access_token = params.get('access_token');
  const refresh_token = params.get('refresh_token');
  return access_token && refresh_token ? { access_token, refresh_token } : null;
}

/**
 * Session tokens from an auth callback URL. Supabase's implicit flow puts them
 * in the hash fragment; the web registration handoff
 * (`/auth/mobile/callback`) puts them in the query string.
 */
export function readCallbackTokens(url: string): CallbackTokens | null {
  try {
    const parsed = new URL(url);
    return (
      tokensFrom(new URLSearchParams(parsed.hash.slice(1))) ?? tokensFrom(parsed.searchParams)
    );
  } catch {
    return null;
  }
}
