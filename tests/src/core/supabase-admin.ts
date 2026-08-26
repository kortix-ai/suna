/**
 * Build headers for Supabase Auth admin endpoints across both key generations.
 *
 * Legacy `service_role` keys are JWTs and must be sent as a Bearer token. New
 * `sb_secret_...` keys are opaque API keys, not JWTs, and Supabase rejects them
 * when they are placed in the Authorization header.
 */
export function supabaseAdminHeaders(
  serviceRoleKey: string,
  options: { anonKey?: string; json?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = options.json
    ? { "content-type": "application/json" }
    : {};

  if (serviceRoleKey.startsWith("sb_secret_")) {
    headers.apikey = serviceRoleKey;
    return headers;
  }

  headers.apikey = options.anonKey ?? serviceRoleKey;
  headers.authorization = `Bearer ${serviceRoleKey}`;
  return headers;
}
