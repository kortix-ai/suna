/**
 * Whether a connection to `databaseUrl` must use TLS. Supabase hosts always
 * accept TLS, so connections to them require it; without this, postgres.js and
 * pg connect in plaintext. An explicit `sslmode`/`ssl` in the URL wins, and
 * local or self-hosted databases are unchanged.
 */
export function requiresTls(databaseUrl: string): boolean {
  try {
    const url = new URL(databaseUrl);
    if (url.searchParams.has('sslmode') || url.searchParams.has('ssl')) return false;
    return /\.supabase\.(co|com)$/i.test(url.hostname);
  } catch {
    return false;
  }
}
