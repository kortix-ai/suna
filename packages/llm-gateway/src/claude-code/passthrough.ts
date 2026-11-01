/**
 * Claude Code passthrough: the model calls of Claude Code in a session's
 * sandbox, on a Claude account the project stores.
 *
 * Claude Code in the box has the gateway as its base URL and the session's
 * gateway token as its login. It sends Anthropic's own request:
 * `POST {base}/v1/messages?beta=true` with its subscription headers
 * (`anthropic-beta: claude-code-…,oauth-…`, `x-app: cli`, …), plus a
 * `HEAD {base}/api/hello` connectivity check. This handler:
 *
 *   1. authenticates the session token (the same principal as every model call);
 *   2. asks the host which Claude accounts this principal may use, in order;
 *   3. forwards the request body byte for byte to Anthropic, with only Claude
 *      Code's own headers and `Authorization: Bearer <account token>`;
 *   4. relays the response (status, type, stream) unchanged.
 *
 * A 429 rests that account and the request moves to the next one; a 401 marks
 * the account for reconnection and moves on. Nothing here translates the
 * request, reads the reply, logs a body or logs a token. The account token
 * never leaves the gateway and the API.
 */
import { createHash } from 'node:crypto';
import type { AuthedPrincipal } from '../domain/principal';
import { upstreamFetch } from '../upstream-fetch';

export interface ClaudeCodeCredential {
  secretId: string;
  /** The account's `sk-ant-oat01-…` token. */
  apiKey: string;
}

export type ClaudeCodeCredentials =
  | { credentials: ClaudeCodeCredential[] }
  | { error: { status: number; code: string; message: string; suggestion?: string; retryAfterSeconds?: number } };

export interface ClaudeCodeHooks {
  authenticate: (token: string) => Promise<AuthedPrincipal | null>;
  /** The Claude accounts the principal may use for `model` (Anthropic's model id), best first, or why none. */
  claudeCredentials: (principal: AuthedPrincipal, input: { model: string | null }) => Promise<ClaudeCodeCredentials>;
  /** Anthropic refused this account's token (401): the host marks it for reconnection. */
  claudeRefused?: (principal: AuthedPrincipal, secretId: string, failedKeySha256: string) => Promise<void>;
  notePoolRateLimit?: (principal: AuthedPrincipal, secretId: string, seconds: number) => Promise<void>;
}

export interface ClaudeCodeRequest {
  method: string;
  /** The path after the passthrough prefix, starting with `/`: `/v1/messages`. */
  path: string;
  /** The query string with its `?`, or ''. */
  search: string;
  headers: Headers;
  body: Uint8Array | null;
  signal?: AbortSignal;
}

export interface ClaudeCodeDeps {
  /** Anthropic's API origin. Default https://api.anthropic.com. */
  upstream?: string;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, 'warn'>;
}

const FORWARDED_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens']);
const DEFAULT_REST_SECONDS = 60;

/** Claude Code's own request headers. Anything else (cookies, proxy headers, the Kortix token) stays here. */
function forwardedHeader(name: string): boolean {
  return name === 'content-type' || name === 'accept' || name === 'user-agent' || name === 'x-app' ||
    name.startsWith('anthropic-') || name.startsWith('x-claude-code-') || name.startsWith('x-stainless-');
}

/** Response headers that describe this hop, or bytes fetch already decoded. */
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'proxy-authenticate', 'set-cookie']);

const ERROR_TYPES: Record<number, string> = {
  400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error',
  429: 'rate_limit_error', 503: 'overloaded_error',
};

function anthropicError(status: number, message: string, retryAfterSeconds?: number): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (retryAfterSeconds) headers['retry-after'] = String(retryAfterSeconds);
  return new Response(JSON.stringify({ type: 'error', error: { type: ERROR_TYPES[status] ?? 'api_error', message } }), { status, headers });
}

function sessionToken(headers: Headers): string | null {
  const bearer = headers.get('authorization')?.match(/^Bearer\s+(\S.*)$/i)?.[1]?.trim();
  if (bearer) return bearer;
  return headers.get('x-api-key')?.trim() || null;
}

/** The request's `model`, read without keeping the parsed body. */
function requestModel(body: Uint8Array | null): string | null {
  if (!body) return null;
  try {
    const model = (JSON.parse(new TextDecoder().decode(body)) as { model?: unknown }).model;
    return typeof model === 'string' ? model : null;
  } catch {
    return null;
  }
}

function restSeconds(response: Response): number {
  const header = Number(response.headers.get('retry-after'));
  return Number.isFinite(header) && header > 0 ? Math.ceil(header) : DEFAULT_REST_SECONDS;
}

function relay(response: Response): Response {
  const headers = new Headers();
  response.headers.forEach((value, key) => {
    if (!HOP_HEADERS.has(key)) headers.set(key, value);
  });
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function createClaudeCodePassthrough(hooks: ClaudeCodeHooks, deps: ClaudeCodeDeps = {}) {
  const upstream = (deps.upstream ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const fetchImpl = deps.fetchImpl ?? upstreamFetch;
  const logger = deps.logger ?? console;

  return async (req: ClaudeCodeRequest): Promise<Response> => {
    if (req.path === '/api/hello') return new Response(null, { status: 200 });
    if (req.method !== 'POST' || !FORWARDED_PATHS.has(req.path)) return anthropicError(404, 'Not found');

    const token = sessionToken(req.headers);
    if (!token) return anthropicError(401, 'Missing Kortix session token');
    const principal = await hooks.authenticate(token);
    if (!principal) return anthropicError(401, 'Invalid Kortix session token');

    const found = await hooks.claudeCredentials(principal, { model: requestModel(req.body) });
    if ('error' in found) {
      const { status, message, suggestion, retryAfterSeconds } = found.error;
      return anthropicError(status, suggestion ? `${message} ${suggestion}` : message, retryAfterSeconds);
    }

    const headers = new Headers();
    req.headers.forEach((value, key) => {
      if (forwardedHeader(key)) headers.set(key, value);
    });
    const target = `${upstream}${req.path}${req.search}`;
    let last: Response | null = null;
    for (const [index, credential] of found.credentials.entries()) {
      headers.set('authorization', `Bearer ${credential.apiKey}`);
      const response = await fetchImpl(target, { method: 'POST', headers, body: req.body as BodyInit | null, signal: req.signal });
      const more = index < found.credentials.length - 1;
      if (response.status === 429) {
        await hooks.notePoolRateLimit?.(principal, credential.secretId, restSeconds(response)).catch((err) => {
          logger.warn('[claude-code] could not record a Claude account rest', { secretId: credential.secretId, error: String(err) });
        });
      } else if (response.status === 401) {
        const digest = createHash('sha256').update(credential.apiKey).digest('hex');
        await hooks.claudeRefused?.(principal, credential.secretId, digest).catch((err) => {
          logger.warn('[claude-code] could not mark a refused Claude account', { secretId: credential.secretId, error: String(err) });
        });
      } else {
        return relay(response);
      }
      if (!more) {
        last = response;
        break;
      }
      // Free the refused attempt's connection before the next one.
      await response.body?.cancel().catch(() => undefined);
    }
    return last ? relay(last) : anthropicError(400, 'No Claude account is available.');
  };
}
