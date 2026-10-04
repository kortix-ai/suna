/**
 * Platinum API client (our own Cloud Hypervisor microVM sandbox platform).
 *
 * Thin fetch wrapper — Platinum is a plain REST API (Bearer pt_live_… key),
 * so unlike Daytona there's no SDK. Every call goes through platinumJson()
 * which adds auth + base URL and surfaces non-2xx as errors with the body.
 *
 * A call about ONE sandbox (`/v1/sandboxes/<id>…`) goes to the control plane
 * that owns that sandbox, once this process has learned it. See
 * "Per-sandbox origin" below.
 */

import { config } from '../lib/config';
import { logger } from '../lib/logger';
import { configuredTimeoutMs } from './with-timeout';

export function isPlatinumConfigured(): boolean {
  return !!config.PLATINUM_API_KEY;
}

function platinumBase(): string {
  const url = config.PLATINUM_API_URL;
  if (!url) throw new Error('Missing PLATINUM_API_URL');
  return url.replace(/\/+$/, '');
}

// ─── Per-sandbox origin ─────────────────────────────────────────────────────
//
// Platinum runs one control plane per region, and a sandbox row lives only in
// its own region's database. `PLATINUM_API_URL` (api.platinum.dev) lands on
// the home (EU) control plane. For a box in another region that control plane
// first asks every peer whether it owns the id (an authenticated GET), then
// forwards the real request, so each call crosses the Atlantic twice. Measured
// on prod 2026-10-02 for one US session box: in the same 70 s the EU control
// plane received 35 Kortix calls and the US one 70, a discovery GET plus the
// forwarded call for each. A GET of that box from a New York client took
// 329 ms median through api.platinum.dev and 26 ms against
// https://us-east.api.platinum.dev directly; from Amsterdam, 243 ms vs 108 ms.
//
// Platinum names the owner itself, so learning it costs no extra call: a
// forwarded response carries `x-pt-served-by: <owner origin>`, and a sandbox
// body carries `api_url` (https://us-east.api.platinum.dev for a US box,
// https://api.platinum.dev for an EU one). Calls for that id then go straight
// to the owner. Until an id is learned, and for everything that is not about
// one sandbox (create, list, templates), the global origin is used, and
// Platinum's own forwarding keeps that path correct.
//
// The Bearer key goes only to an origin that is the configured host or a
// subdomain of it, over https on the default port. A response cannot point the
// key anywhere else.

const SERVED_BY_HEADER = 'x-pt-served-by';
const SANDBOX_ID_PATH = /^\/v1\/sandboxes\/([^/?#]+)(?=[/?#]|$)/;
const SANDBOX_COLLECTION_PATH = /^\/v1\/sandboxes(?=[?#]|$)/;
/** One entry per sandbox this process has called; the oldest goes first. */
export const PLATINUM_ORIGIN_CACHE_MAX = 10_000;
// replica-local: learned owner-origin routing. A replica that has not learned
// an id yet routes via the configured global origin, which Platinum forwards
// to the owner itself — one extra hop, never a wrong answer. Each replica
// learns on its own first call.
const sandboxOrigins = new Map<string, string>();

function sandboxIdOf(path: string): string | null {
  return SANDBOX_ID_PATH.exec(path)?.[1] ?? null;
}

/**
 * The normalized origin of `candidate` if the Bearer key may be sent there,
 * else null. Accepts the configured origin itself, or an https origin on the
 * default port whose host is the configured host or a subdomain of it, with no
 * credentials, path, query or fragment.
 */
export function acceptedPlatinumOrigin(candidate: unknown): string | null {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  let base: URL;
  let url: URL;
  try {
    base = new URL(platinumBase());
    url = new URL(candidate.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/') return null;
  if (url.origin === base.origin) return base.origin;
  if (url.protocol !== 'https:' || url.port !== '') return null;
  const host = url.hostname;
  const baseHost = base.hostname;
  if (host !== baseHost && !host.endsWith(`.${baseHost}`)) return null;
  return url.origin;
}

function rememberSandboxOrigin(sandboxId: string, candidate: unknown): void {
  const origin = acceptedPlatinumOrigin(candidate);
  if (!origin) return;
  sandboxOrigins.delete(sandboxId);
  // The configured origin already reaches this box: nothing to remember.
  if (origin === new URL(platinumBase()).origin) return;
  if (sandboxOrigins.size >= PLATINUM_ORIGIN_CACHE_MAX) {
    const oldest = sandboxOrigins.keys().next().value;
    if (oldest !== undefined) sandboxOrigins.delete(oldest);
  }
  sandboxOrigins.set(sandboxId, origin);
}

// Region → origin, learned from boxes this process has already seen in that
// region (their `api_url` / `x-pt-served-by`). A CREATE names its region in the
// body but has no box id yet, so without this it always went to the global
// origin: for a US box that is Kortix → EU control plane → US control plane,
// one transatlantic forward per create (Dev, 2026-10-02: the US create also
// paid the EU hop while every later call for the box went direct).
// replica-local: same contract as the sandbox origins — an unlearned replica
// pays the extra forward through the global origin, it never mis-routes.
const regionOrigins = new Map<string, string>();

function rememberRegionOrigin(region: unknown, candidate: unknown): void {
  if (typeof region !== 'string' || !/^[a-z]{2,8}-[a-z]{2,12}$/.test(region)) return;
  const origin = acceptedPlatinumOrigin(candidate);
  if (!origin) return;
  if (origin === new URL(platinumBase()).origin) {
    regionOrigins.delete(region);
    return;
  }
  regionOrigins.set(region, origin);
}

/** The origin a create naming `region` goes to now: learned, else global. */
export function platinumOriginForRegion(region: string): string {
  return regionOrigins.get(region) ?? new URL(platinumBase()).origin;
}

function createRegionOf(path: string, method: string, body: unknown): string | null {
  if (method !== 'POST' || !SANDBOX_COLLECTION_PATH.test(path) || typeof body !== 'string') return null;
  try {
    const region = (JSON.parse(body) as { region?: unknown }).region;
    return typeof region === 'string' && region ? region : null;
  } catch {
    return null;
  }
}

/** The origin a call about `sandboxId` goes to now. */
export function platinumOriginForSandbox(sandboxId: string): string {
  return sandboxOrigins.get(sandboxId) ?? new URL(platinumBase()).origin;
}

/** Test-only. */
export function __resetPlatinumSandboxOriginsForTests(): void {
  sandboxOrigins.clear();
  regionOrigins.clear();
}

function learnFromResponse(path: string, method: string, res: Response, body: unknown): void {
  const record =
    body && typeof body === 'object' ? (body as { id?: unknown; api_url?: unknown }) : null;
  let sandboxId = sandboxIdOf(path);
  // A create (POST /v1/sandboxes) answers with the new box: its id is in the body.
  if (
    !sandboxId &&
    method === 'POST' &&
    SANDBOX_COLLECTION_PATH.test(path) &&
    typeof record?.id === 'string'
  ) {
    sandboxId = record.id;
  }
  if (!sandboxId) return;
  const servedBy = res.headers.get(SERVED_BY_HEADER);
  rememberSandboxOrigin(sandboxId, servedBy);
  if (record?.id === sandboxId && record.api_url !== undefined) {
    rememberSandboxOrigin(sandboxId, record.api_url);
  }
  // Only an answer that names THIS box and its region can teach a region.
  if (record?.id === sandboxId) {
    const region = (record as { region?: unknown }).region;
    rememberRegionOrigin(region, record.api_url ?? servedBy);
  }
}

// Bun's codes for a connection that was never established, so the request
// cannot have reached Platinum (probed on Bun 1.3.14: refused and unresolvable
// both read `ConnectionRefused`; a bad certificate carries the TLS code).
const NOT_CONNECTED_CODES = new Set([
  'ConnectionRefused',
  'FailedToOpenSocket',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * Whether a failed call to a learned regional origin may be sent once more to
 * the global origin. A timeout or abort may not: its budget is spent. A read
 * may retry after any network failure. A write retries only when the
 * connection never opened. A reset after the request was sent may already have
 * run it (an exec, a stop).
 */
function retryOnGlobalOrigin(err: unknown, method: string, signal: AbortSignal): boolean {
  if (signal.aborted || !(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return false;
  if (method === 'GET' || method === 'HEAD') return true;
  const code = String((err as { code?: unknown }).code ?? '');
  return NOT_CONNECTED_CODES.has(code) || code.startsWith('ERR_TLS_') || code.includes('CERT');
}

// Bare `fetch()` has NO default timeout — a stalled connection to Platinum
// hangs the caller forever, same failure class as the Daytona SDK's 24h axios
// default (see platform/providers/daytona.ts for the full incident writeup).
// Platinum is dev's default sandbox provider, and getStatus()/stop()/start()
// here sit on the exact same reaper hot path, so this is bounded by default.
// A caller that needs a longer/no bound (e.g. a deliberately long-poll) can
// still pass its own `init.signal` — this only fills in a default.
const DEFAULT_CALL_TIMEOUT_MS = configuredTimeoutMs(
  'KORTIX_PLATINUM_CALL_TIMEOUT_MS',
  20_000,
  1_000,
);

async function platinumFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!config.PLATINUM_API_KEY) throw new Error('Missing PLATINUM_API_KEY');
  // Track whether WE picked the timeout budget so the error message below
  // reports the real one instead of always claiming the default — a caller
  // like create() passes its own longer signal (70s, for Platinum's 60s
  // server-side wait_timeout_ms long-poll) and a message claiming "20000ms"
  // there would under-report the real elapsed time and mislead debugging of
  // exactly the incident class this bound exists to make observable.
  const usingDefault = init.signal === undefined;
  const signal = init.signal ?? AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS);
  const method = (init.method ?? 'GET').toUpperCase();
  const send = (base: string) =>
    fetch(`${base}${path}`, {
      ...init,
      signal,
      headers: {
        Authorization: `Bearer ${config.PLATINUM_API_KEY}`,
        'Content-Type': 'application/json',
        // Caller-supplied headers (plain object literal — NOT a Headers
        // instance, which wouldn't spread) win over the defaults above. This
        // is how platinum.ts's create-dedup (S1) forwards a deterministic
        // `Idempotency-Key`: Platinum's CP implements it (8-255 chars, scoped
        // per actor+key — same key + a semantically-identical body replays
        // the already-committed sandbox instead of creating a second one), so
        // this path is load-bearing, not inert.
        ...(init.headers ?? {}),
      },
    });
  const sandboxId = sandboxIdOf(path);
  const createRegion = sandboxId ? null : createRegionOf(path, method, init.body);
  const regional = sandboxId
    ? sandboxOrigins.get(sandboxId)
    : createRegion
      ? regionOrigins.get(createRegion)
      : undefined;
  try {
    if (!regional) return await send(platinumBase());
    try {
      return await send(regional);
    } catch (err) {
      if (!retryOnGlobalOrigin(err, method, signal)) throw err;
      // Forget the owner; the global origin forwards to it and the answer
      // names it again.
      if (sandboxId && sandboxOrigins.get(sandboxId) === regional) sandboxOrigins.delete(sandboxId);
      if (createRegion && regionOrigins.get(createRegion) === regional) regionOrigins.delete(createRegion);
      logger.warn(
        `[platinum] ${method} ${path} via ${regional} failed (${err instanceof Error ? ((err as { code?: unknown }).code ?? err.message) : err}); retrying once via the global origin`,
      );
      return await send(platinumBase());
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      const budget = usingDefault
        ? `${DEFAULT_CALL_TIMEOUT_MS}ms (default)`
        : 'caller-provided budget';
      const timeout = new Error(`platinum ${init.method ?? 'GET'} ${path} timed out after ${budget}`);
      timeout.name = 'TimeoutError';
      throw timeout;
    }
    throw err;
  }
}

/**
 * A non-2xx Platinum answer. The message keeps the historical
 * `platinum <method> <path> -> <status> <body>` shape for logs; callers
 * classify by `status` and `code` (the JSON body's `code`), never the text.
 */
export class PlatinumHttpError extends Error {
  readonly code?: string;
  constructor(
    message: string,
    readonly status: number,
    readonly body = '',
  ) {
    super(message);
    this.name = 'PlatinumHttpError';
    try {
      const code = (JSON.parse(body) as { code?: unknown }).code;
      if (typeof code === 'string') this.code = code;
    } catch {
      // not JSON: no code
    }
  }
}

/**
 * Expected, transient: Platinum auto-stops idle microVMs natively (see
 * PlatinumProvider) and resumes them CoW on reopen. While a box is in that
 * stopped state, POST /:id/expose (and any port-forwarding op) answers
 * `409 {"error":"sandbox not running","code":"sandbox_not_running"}`. That is
 * the system working as designed — the caller (preview proxy, transcript
 * resolver, lease discoverer) either wakes the box and retries, or surfaces a
 * retryable 503 to the client. It is NOT a 500-worthy error and must NOT page
 * Sentry, so it gets its own typed error that `app.onError` classifies out of
 * `captureException` (mirroring the request-deadline 503 pattern). Every OTHER
 * non-2xx still throws a plain `PlatinumHttpError` and is captured normally —
 * only this one expected state is special-cased, so unexpected failures stay
 * loud.
 */
export class PlatinumSandboxNotRunningError extends PlatinumHttpError {
  constructor(message = 'sandbox is not running', body = '{"code":"sandbox_not_running"}') {
    super(message, 409, body);
    this.name = 'PlatinumSandboxNotRunningError';
  }
}

export function isPlatinumSandboxNotRunningError(err: unknown): boolean {
  return err instanceof PlatinumSandboxNotRunningError;
}

// Platinum signals a stopped box with `409 {"code":"sandbox_not_running"}`.
// Match the structured `code` field (not a message substring) so a different
// 409 reason never gets misclassified into the "expected" bucket.
function isSandboxNotRunningBody(status: number, text: string): boolean {
  if (status !== 409) return false;
  try {
    const body = JSON.parse(text) as { code?: unknown; error?: unknown };
    return body.code === 'sandbox_not_running';
  } catch {
    return false;
  }
}

export type PlatinumJsonResponse<T> = {
  status: number;
  body: T;
};

/**
 * GET/POST JSON while preserving the successful HTTP status. Non-2xx behavior
 * stays identical to platinumJson(), including typed stopped-sandbox errors.
 */
export async function platinumJsonResponse<T>(
  path: string,
  init: RequestInit = {},
): Promise<PlatinumJsonResponse<T>> {
  const res = await platinumFetch(path, init);
  const text = await res.text();
  const method = (init.method ?? 'GET').toUpperCase();
  if (!res.ok) {
    learnFromResponse(path, method, res, null);
    // Expected auto-stopped state → typed error (controlled 503, no Sentry).
    if (isSandboxNotRunningBody(res.status, text)) {
      throw new PlatinumSandboxNotRunningError(
        `platinum ${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`,
        text,
      );
    }
    // Surface Retry-After (seconds) on a 429 so poll-error classification can
    // honor it (PHASE 2 rate-limit handling). Harmless suffix for other callers.
    let suffix = '';
    if (res.status === 429) {
      const ra = res.headers.get('retry-after');
      if (ra && /^\d+$/.test(ra.trim())) suffix = ` retry-after=${ra.trim()}`;
    }
    throw new PlatinumHttpError(
      `platinum ${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}${suffix}`,
      res.status,
      text,
    );
  }
  const body = (text ? JSON.parse(text) : {}) as T;
  learnFromResponse(path, method, res, body);
  return { status: res.status, body };
}

/** GET/POST JSON. Throws `PlatinumHttpError` on non-2xx. */
export async function platinumJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await platinumJsonResponse<T>(path, init)).body;
}
