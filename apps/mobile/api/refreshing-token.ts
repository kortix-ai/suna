/**
 * The SDK `getToken` for mobile: the stored Supabase session's token, plus the
 * `invalidate` hook the SDK calls on a 401. After a 401 the next read refreshes
 * the session instead of re-reading the token the API just rejected. One
 * refresh serves every parallel 401. No React Native imports: `api/config.ts`
 * binds it to Supabase.
 */
export interface TokenSource {
  /** The stored session's access token (supabase-js refreshes it near expiry). */
  read: () => Promise<string | null>;
  /** Force a refresh with the refresh token; null when it fails. */
  refresh: () => Promise<string | null>;
}

export function createRefreshingToken(source: TokenSource) {
  let issued: string | null = null;
  let forceNext = false;
  let refreshing: Promise<string | null> | null = null;

  const getToken = async (): Promise<string | null> => {
    if (refreshing) return refreshing;
    if (forceNext) {
      forceNext = false;
      const pending = source
        .refresh()
        .then((token) => token ?? source.read())
        .then((token) => (issued = token))
        .finally(() => {
          if (refreshing === pending) refreshing = null;
        });
      refreshing = pending;
      return pending;
    }
    return (issued = await source.read());
  };

  return Object.assign(getToken, {
    invalidate: (rejectedToken: string): void => {
      if (rejectedToken !== issued) return;
      issued = null;
      forceNext = true;
    },
  });
}
