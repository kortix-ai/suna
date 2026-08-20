/**
 * The error class for everything under `core/auth`.
 *
 * Named `KortixAuthError`, not `AuthError`, because `AuthError` is ALREADY a
 * published name — it is the REST `401` class exported from
 * `core/http/api/errors` and recorded in `public-surface.snapshot.json`.
 * Renaming a published name breaks every consumer, so the `Kortix` prefix
 * earns its keep here exactly as `AGENTS.md` describes: it disambiguates two
 * genuinely different concepts (a Kortix REST 401 vs a GoTrue/discovery
 * failure).
 *
 * `.code` is first class, not buried inside `.body`, because callers branch on
 * it: `invalid_credentials`, `otp_expired`, `email_not_confirmed`,
 * `invalid_grant`, `over_email_send_rate_limit`, plus the SDK-side codes
 * `auth_config_unavailable`, `auth_config_unsupported`, and `pkce_unsupported`.
 */
export class KortixAuthError extends Error {
  /** HTTP status, or `0` when the failure never reached the network. */
  readonly status: number;
  /** GoTrue `error_code`, else `error`, else `null`. */
  readonly code: string | null;
  /** The parsed response body, or the raw text when it was not JSON. */
  readonly body: unknown;

  constructor(
    message: string,
    options?: { status?: number; code?: string | null; body?: unknown },
  ) {
    super(message);
    this.name = 'KortixAuthError';
    this.status = options?.status ?? 0;
    this.code = options?.code ?? null;
    this.body = options?.body;
  }
}

/**
 * The `fetch` shape this module needs. Deliberately narrower than
 * `typeof fetch` (no `preconnect` static) so a plain
 * `async (input, init?) => new Response(...)` stub satisfies it — the same
 * choice `core/http/api-client.ts` makes for its injection point.
 */
export type AuthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Parse a response body as JSON, falling back to raw text, then to null. */
export async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Map a non-2xx response to a `KortixAuthError`.
 *
 * Code precedence is GoTrue's own: `error_code`, else `error`, else `null`.
 * Message precedence is `error_description` → `msg` → `error` → `statusText`,
 * which is the order that yields the sentence a user should see.
 */
export function authErrorFromResponse(
  response: Response,
  body: unknown,
  fallbackMessage?: string,
): KortixAuthError {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const pick = (key: string): string | null =>
    typeof record[key] === 'string' && (record[key] as string).length > 0
      ? (record[key] as string)
      : null;

  const code = pick('error_code') ?? pick('error') ?? null;
  const message =
    pick('error_description') ??
    pick('msg') ??
    pick('message') ??
    pick('error') ??
    fallbackMessage ??
    response.statusText ??
    `HTTP ${response.status}`;

  return new KortixAuthError(message, { status: response.status, code, body });
}
