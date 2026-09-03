/**
 * Black-box typed HTTP client. Hits the real API over the wire (fetch), injects
 * auth per-principal, and auto-captures every request/response (redacted) into
 * the active step. Callers pass route TEMPLATES with `/v1/...` and `:param`
 * placeholders so coverage aggregation is exact and unambiguous.
 *
 *   await client.as(P.OWNER).get("/v1/projects/:id", { params: { id } }).then(r => r.status(200))
 */
import { currentRecorder } from './context';
import { assert, BodyAssert } from './expect';
import { log } from './log';
import type { Captured } from './result';

export type Auth =
  | { mode: 'none' }
  | { mode: 'bearer'; token: string }
  | { mode: 'query-token'; token: string } // ?token= (preview proxy / WS)
  | { mode: 'header-token'; token: string } // X-Kortix-Token
  | { mode: 'cookie'; cookie: string }; // raw Cookie header

export interface Identity {
  label: string;
  auth: Auth;
}

export const ANON: Identity = { label: 'ANON', auth: { mode: 'none' } };

/** True when the HTTP client marked an error as a transient network failure. */
export function isKe2eRetryableError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'ke2eRetryable' in error &&
    (error as { ke2eRetryable?: unknown }).ke2eRetryable === true
  );
}

const DEFAULT_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_AFTER_MS = 15_000;

/** Return the host-requested retry delay for a marked transient failure. */
export function ke2eRetryDelayMs(
  error: unknown,
  fallbackMs = DEFAULT_RETRY_DELAY_MS,
): number {
  if (!isKe2eRetryableError(error)) return fallbackMs;
  const delay = (error as { ke2eRetryAfterMs?: unknown }).ke2eRetryAfterMs;
  if (typeof delay !== 'number' || !Number.isFinite(delay)) return fallbackMs;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(fallbackMs, Math.trunc(delay)));
}

export interface ReqOpts {
  /** `:param` substitutions for the URL (template stays the coverage key). */
  params?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** JSON body unless `raw` is set or it's a string/FormData. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Send body verbatim (no JSON.stringify, no content-type). */
  raw?: boolean;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
}

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'apikey',
  'cookie',
  'set-cookie',
  'x-kortix-token',
  'x-kortix-signature',
  'x-hub-signature',
  'x-hub-signature-256',
  'stripe-signature',
]);

const SENSITIVE_BODY_KEYS =
  /(token|secret|password|api[_-]?key|push_token|private[_-]?key|access_token|refresh_token|client_secret)/i;

function mask(value: string): string {
  if (!value) return value;
  const head = value.slice(0, 6);
  return `${head}***[${value.length}]`;
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => (out[k] = v));
  return out;
}

function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? mask(v) : v;
  }
  return out;
}

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_BODY_KEYS.test(k) && typeof v === 'string') out[k] = mask(v);
      else out[k] = redactJson(v);
    }
    return out;
  }
  return value;
}

function redactBodyText(text: string | undefined): string | undefined {
  if (!text) return text;
  try {
    return JSON.stringify(redactJson(JSON.parse(text)));
  } catch {
    // Not JSON — best-effort mask of obvious token-looking substrings.
    return text.replace(
      /(kortix_[a-z]*_?[A-Za-z0-9]{6,}|sk-[A-Za-z0-9]{6,}|eyJ[A-Za-z0-9_.-]{10,})/g,
      (m) => mask(m),
    );
  }
}

/** Wraps a captured response with assertion sugar. */
export class Res {
  constructor(public readonly captured: Captured) {}

  get statusCode(): number {
    return this.captured.res.status;
  }

  text(): string {
    return this.captured.res.bodyText;
  }

  json<T = any>(): T {
    return this.captured.res.json as T;
  }

  header(name: string): string | undefined {
    return this.captured.res.headers[name.toLowerCase()];
  }

  /** Assert the status code (exact or set membership). */
  status(code: number | number[]): this {
    const codes = Array.isArray(code) ? code : [code];
    if (!codes.includes(this.statusCode) && isKe2eTransientGatewayResponse(this)) {
      const breakerOpen = transientBreaker.isOpen();
      const error = new Error(
        `transient gateway status ${this.statusCode}; expected [${codes.join(', ')}] ` +
          `${describeEdgeResponse(this.statusCode, this.captured.res.headers)}` +
          (breakerOpen ? ` — ${transientBreaker.describe()}` : ''),
      );
      // With the breaker open the flow-level budget must not re-amplify this.
      (error as any).ke2eRetryable = !breakerOpen;
      (error as any).ke2eRetryAfterMs = retryAfterMs(this.header('retry-after'));
      throw error;
    }
    assert({
      kind: 'status',
      description: `status in [${codes.join(', ')}]`,
      expected: codes,
      actual: this.statusCode,
      pass: codes.includes(this.statusCode),
    });
    return this;
  }

  headerEquals(name: string, expected: string | RegExp): this {
    const actual = this.header(name);
    const pass =
      expected instanceof RegExp
        ? typeof actual === 'string' && expected.test(actual)
        : actual === expected;
    assert({
      kind: 'header',
      description: `header ${name} ${expected instanceof RegExp ? 'matches ' + expected : '=== ' + expected}`,
      expected: expected.toString(),
      actual,
      pass,
    });
    return this;
  }

  headerExists(name: string): this {
    const actual = this.header(name);
    assert({
      kind: 'header.exists',
      description: `header ${name} present`,
      expected: '<present>',
      actual,
      pass: actual !== undefined,
    });
    return this;
  }

  body(): BodyAssert {
    return new BodyAssert(this.json());
  }
}

/**
 * Detect a gateway-generated outage response.
 *
 * API responses carry x-request-id. Cloudflare host failures do not. This
 * distinction prevents retries from hiding a real API 5xx contract failure.
 */
export function isKe2eTransientGatewayResponse(response: Res): boolean {
  if (![502, 503, 504].includes(response.statusCode)) return false;
  if (response.header('x-request-id')) return false;
  return (
    response.header('retry-after') !== undefined ||
    response.header('content-type')?.includes('text/html') === true
  );
}

/**
 * Methods this client may re-send after an edge-laundered 5xx or a network error.
 *
 * The Cloudflare worker launders an origin timeout into a synthetic 503 AFTER
 * the origin has already COMMITTED the write. Run 32306385663 proved it six
 * times over: TRG-2, TRG-10, TRG-14, TOK-5, MEM-7, IAM-26 and CLI-TRG each sent
 * one POST that stalled ~25 s at the origin, took the synthetic 503, were
 * re-sent by this client, and the second send hit the row the FIRST send had
 * already written — `409 A trigger with slug "nightly" already exists`,
 * `409 a role with this key already exists`, `409 Already a member`. Every one
 * of those flows had provisioned a brand-new project or team microseconds
 * earlier, so no other shard and no gc debris could have owned that name. The
 * retry manufactured the collision.
 *
 * A retry is only transparent when re-sending cannot create a second resource.
 * POST is the one method in this API that creates, so POST is never re-sent.
 * Its laundered 503 is returned to the caller instead, where `.status()` (or
 * `throwIfEdgeLaundered` for a body-only read) raises a marked-retryable error
 * and the FLOW-level infra budget re-runs the flow against fresh fixtures — a
 * fresh project, a fresh team, a fresh name, and therefore no collision.
 *
 * GET/HEAD/OPTIONS are safe by definition. PUT, PATCH and DELETE all address an
 * EXISTING resource by id (upsert-by-key, partial-update-by-id, delete-by-id),
 * so re-sending them cannot mint a second row; they keep the cheaper in-request
 * retry. Narrowing the exclusion to POST alone also keeps this change to
 * exactly the defect the run proved, instead of converting healthy in-request
 * recoveries into whole-flow re-runs.
 */
const REPLAY_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']);

/** True when re-sending this method cannot duplicate a server-side create. */
export function isReplaySafeMethod(method: string): boolean {
  return REPLAY_SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Raise a marked-retryable error when a response is an edge-laundered 5xx.
 *
 * `Res.status()` already does this, but fixtures and flows that read a body
 * WITHOUT asserting a status never reach it: they throw their own plain Error
 * ("team account create returned no id: …"), which `classifyFlowError` reads as
 * `fatal` and never retries. IAM-22 died that way on a single attempt while the
 * identical blip on an asserted route self-healed. Call this before any
 * body-only read so the edge can never masquerade as a contract failure.
 */
export function throwIfEdgeLaundered(response: Res, what: string): void {
  if (!isKe2eTransientGatewayResponse(response)) return;
  const breakerOpen = transientBreaker.isOpen();
  const error = new Error(
    `${what}: transient gateway status ${response.statusCode} ` +
      `${describeEdgeResponse(response.statusCode, response.captured.res.headers)}` +
      (breakerOpen ? ` — ${transientBreaker.describe()}` : ''),
  );
  (error as any).ke2eRetryable = !breakerOpen;
  (error as any).ke2eRetryAfterMs = retryAfterMs(response.header('retry-after'));
  throw error;
}

function retryAfterMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - Date.now());
}

/**
 * Describe WHERE a response came from, terse enough for an error message.
 *
 * The Cloudflare worker replaces any origin throw or 502/503/504 with a
 * synthetic maintenance 503 that carries `X-Maintenance-Mode` and drops the
 * origin's `x-request-id`. Printing both facts lets a log reader tell an edge
 * laundering apart from a genuine application 5xx without guessing.
 */
export function describeEdgeResponse(
  status: number,
  headers: Record<string, string>,
): string {
  const maintenance = headers['x-maintenance-mode'];
  const requestId = headers['x-request-id'];
  const origin = requestId ? 'origin' : maintenance ? 'edge-laundered' : 'edge';
  return (
    `[${origin} status=${status} ` +
    `x-maintenance-mode=${maintenance ?? 'absent'} ` +
    `x-request-id=${requestId ? 'present' : 'absent'}]`
  );
}

const RETRY_BASE_DELAY_MS = Number(process.env.KE2E_RETRY_BASE_DELAY_MS ?? 500);
const RETRY_MAX_DELAY_MS = Number(process.env.KE2E_RETRY_MAX_DELAY_MS ?? 8_000);

/**
 * Exponential backoff with FULL jitter for the in-request transient retry.
 *
 * The old policy was a fixed 2s × 4 attempts. Layered under 3 flow attempts one
 * request could hit the origin 12 times, and every client backed off in
 * lockstep — a textbook metastable failure that turns a staging blip into a
 * run-ending cascade. Full jitter spreads the retries; the cap bounds the
 * worst case. A `Retry-After` from the edge raises the floor but never parks
 * longer than the cap.
 */
export function transientRetryDelayMs(
  attempt: number,
  opts: {
    baseMs?: number;
    capMs?: number;
    retryAfterMs?: number;
    random?: () => number;
  } = {},
): number {
  const base = opts.baseMs ?? RETRY_BASE_DELAY_MS;
  const cap = opts.capMs ?? RETRY_MAX_DELAY_MS;
  const random = opts.random ?? Math.random;
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(random() * ceiling);
  const floor =
    typeof opts.retryAfterMs === 'number' && Number.isFinite(opts.retryAfterMs)
      ? Math.max(0, opts.retryAfterMs)
      : 0;
  return Math.min(cap, Math.max(jittered, floor));
}

export interface BreakerOptions {
  /** Transient edge failures within the window that trip the breaker. 0 disables. */
  threshold: number;
  windowMs: number;
  now?: () => number;
}

/**
 * Process-wide circuit breaker over laundered-503 / network-failure events.
 *
 * Once the deployment is observably overloaded, more retries are the problem,
 * not the remedy. When the breaker is open the client stops retrying and stops
 * marking the failure retryable, so the flow-level budget cannot re-amplify it
 * either. The window is rolling: the breaker closes on its own once the
 * failures age out.
 */
export class TransientCircuitBreaker {
  private events: number[] = [];
  private openSince: number | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: BreakerOptions) {
    this.now = opts.now ?? Date.now;
  }

  private prune(at: number): void {
    const cutoff = at - this.opts.windowMs;
    while (this.events.length > 0 && this.events[0] <= cutoff) this.events.shift();
  }

  record(): void {
    const at = this.now();
    this.prune(at);
    this.events.push(at);
  }

  failuresInWindow(): number {
    this.prune(this.now());
    return this.events.length;
  }

  isOpen(): boolean {
    if (this.opts.threshold <= 0) return false;
    const open = this.failuresInWindow() >= this.opts.threshold;
    if (!open) this.openSince = null;
    return open;
  }

  /** True exactly once per open transition, so callers log one line, not thousands. */
  shouldAnnounce(): boolean {
    if (!this.isOpen()) return false;
    if (this.openSince !== null) return false;
    this.openSince = this.now();
    return true;
  }

  describe(): string {
    return (
      `circuit open: ${this.failuresInWindow()} transient edge failures in ` +
      `${this.opts.windowMs}ms (threshold ${this.opts.threshold}) — the deployment is ` +
      'overloaded; not retrying'
    );
  }

  reset(): void {
    this.events = [];
    this.openSince = null;
  }
}

export function readBreakerOptions(
  vars: Record<string, string | undefined> = process.env,
): BreakerOptions {
  const threshold = Number(vars.KE2E_BREAKER_THRESHOLD ?? 20);
  const windowMs = Number(vars.KE2E_BREAKER_WINDOW_MS ?? 60_000);
  return {
    threshold: Number.isFinite(threshold) ? Math.trunc(threshold) : 20,
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? Math.trunc(windowMs) : 60_000,
  };
}

/** The one breaker every Client in the process shares. */
export const transientBreaker = new TransientCircuitBreaker(readBreakerOptions());

function announceBreaker(): void {
  if (transientBreaker.shouldAnnounce()) log.warn(`ke2e ${transientBreaker.describe()}`);
}

export class Client {
  private readonly origin: string;

  /**
   * Build a client for a service URL whose public mount can include a path.
   *
   * The normal constructor is API-oriented: it deliberately discards `/v1`
   * because the route templates already contain the API mount. A preview puts
   * the standalone gateway below `/_gateway`, so gateway requests must keep
   * that prefix without changing their route templates or coverage keys.
   */
  static forBaseUrl(baseUrl: string): Client {
    const url = new URL(baseUrl);
    const pathPrefix = url.pathname.replace(/\/+$/, '');
    return new Client(
      url.origin,
      ANON,
      60_000,
      Number(process.env.KE2E_GATEWAY_RETRIES ?? 3),
      pathPrefix,
    );
  }

  constructor(
    apiUrl: string,
    private readonly identity: Identity = ANON,
    private readonly defaultTimeoutMs = 60_000,
    // Retry gateway-generated transient 502/503/504 by DEFAULT, for every client
    // — including the fixture clients (world.ts, provision.ts) that create
    // sessions/sandboxes. Under concurrent deployed load a session-create can
    // briefly exceed the edge timeout and come back as a laundered 503
    // MAINTENANCE_MODE (Retry-After set, NO x-request-id); retrying lets it
    // self-heal when the momentary contention clears. SAFE: the classifier
    // (isKe2eTransientGatewayResponse) only matches responses WITHOUT
    // x-request-id, so a genuine app 5xx still fails. Overridable per env
    // (KE2E_GATEWAY_RETRIES) via runner.ts.
    private readonly transientGatewayRetries = Number(
      process.env.KE2E_GATEWAY_RETRIES ?? 3,
    ),
    private readonly pathPrefix = '',
  ) {
    this.origin = new URL(apiUrl).origin;
  }

  /** Clone bound to a principal/identity. */
  as(identity: Identity): Client {
    return new Client(
      this.origin,
      identity,
      this.defaultTimeoutMs,
      this.transientGatewayRetries,
      this.pathPrefix,
    );
  }

  withBearer(token: string, label = 'raw'): Client {
    return this.as({ label, auth: { mode: 'bearer', token } });
  }

  /**
   * Retry marked network errors and gateway-generated 502/503/504 responses.
   *
   * Callers must opt in only for requests that are safe to repeat.
   */
  withTransientGatewayRetries(retries = 3): Client {
    return new Client(this.origin, this.identity, this.defaultTimeoutMs, retries, this.pathPrefix);
  }

  get(t: string, o?: ReqOpts) {
    return this.request('GET', t, o);
  }
  post(t: string, body?: unknown, o?: ReqOpts) {
    return this.request('POST', t, { ...o, body });
  }
  put(t: string, body?: unknown, o?: ReqOpts) {
    return this.request('PUT', t, { ...o, body });
  }
  patch(t: string, body?: unknown, o?: ReqOpts) {
    return this.request('PATCH', t, { ...o, body });
  }
  del(t: string, o?: ReqOpts) {
    return this.request('DELETE', t, o);
  }

  private applyAuth(headers: Headers, url: URL): void {
    const a = this.identity.auth;
    switch (a.mode) {
      case 'bearer':
        headers.set('authorization', `Bearer ${a.token}`);
        break;
      case 'header-token':
        headers.set('x-kortix-token', a.token);
        break;
      case 'cookie':
        headers.set('cookie', a.cookie);
        break;
      case 'query-token':
        url.searchParams.set('token', a.token);
        break;
      case 'none':
        break;
    }
  }

  async request(method: string, template: string, opts?: ReqOpts): Promise<Res> {
    let path = template;
    if (opts?.params) {
      for (const [k, v] of Object.entries(opts.params)) {
        path = path.replace(new RegExp(`:${k}(?=/|$|\\.)`, 'g'), encodeURIComponent(String(v)));
      }
    }
    const requestPath =
      this.pathPrefix && path !== this.pathPrefix && !path.startsWith(`${this.pathPrefix}/`)
        ? `${this.pathPrefix}${path.startsWith('/') ? '' : '/'}${path}`
        : path;
    const url = new URL(this.origin + requestPath);
    if (opts?.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const headers = new Headers();
    let bodyInit: BodyInit | undefined;
    if (opts?.body !== undefined) {
      if (opts.raw || typeof opts.body === 'string') {
        bodyInit = opts.body as string;
      } else if (opts.body instanceof FormData) {
        bodyInit = opts.body;
      } else {
        headers.set('content-type', 'application/json');
        bodyInit = JSON.stringify(opts.body);
      }
    }
    for (const [k, v] of Object.entries(opts?.headers ?? {})) headers.set(k, v);
    this.applyAuth(headers, url);
    applyCiPassthrough(headers);

    const routeTemplate = `${method} ${template}`;
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    // A create is never replayed — see REPLAY_SAFE_METHODS. One attempt, then
    // the laundered response goes back to the caller for a FLOW-level retry.
    const replaySafe = isReplaySafeMethod(method);
    const maxAttempts = replaySafe ? this.transientGatewayRetries + 1 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const started = performance.now();
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: bodyInit,
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'manual',
        });
      } catch (err: any) {
        // Surface as a captured network failure.
        const ms = performance.now() - started;
        const captured: Captured = {
          routeTemplate,
          req: { method, url: url.toString(), headers: redactHeaders(headersToObject(headers)) },
          res: { status: 0, headers: {}, bodyText: String(err?.message ?? err) },
          ms,
        };
        record(captured);
        transientBreaker.record();
        const breakerOpen = transientBreaker.isOpen();
        if (breakerOpen) announceBreaker();
        if (attempt < maxAttempts && !breakerOpen) {
          await new Promise((resolve) =>
            setTimeout(resolve, transientRetryDelayMs(attempt)),
          );
          continue;
        }
        const e = new Error(
          `network error ${method} ${url} after ${attempt}/${maxAttempts} attempt(s): ` +
            `${err?.message ?? err}` +
            (breakerOpen ? ` — ${transientBreaker.describe()}` : ''),
        );
        (e as any).ke2eRetryable = !breakerOpen;
        throw e;
      }

      const bodyText = await res.text();
      const ms = performance.now() - started;
      const resHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => (resHeaders[k] = k.toLowerCase() === 'set-cookie' ? mask(v) : v));
      let json: unknown;
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        try {
          json = JSON.parse(bodyText);
        } catch {
          /* leave undefined */
        }
      }

      const captured: Captured = {
        routeTemplate,
        req: {
          method,
          url: url.toString(),
          headers: redactHeaders(headersToObject(headers)),
          body: redactBodyText(typeof bodyInit === 'string' ? bodyInit : undefined),
        },
        res: {
          status: res.status,
          headers: resHeaders,
          bodyText: redactBodyText(bodyText) ?? '',
          json,
        },
        ms,
      };
      record(captured);
      const response = new Res(captured);
      if (isKe2eTransientGatewayResponse(response)) {
        transientBreaker.record();
        const breakerOpen = transientBreaker.isOpen();
        if (breakerOpen) announceBreaker();
        if (attempt < maxAttempts && !breakerOpen) {
          log.warn(
            `ke2e retry ${attempt}/${maxAttempts} ${routeTemplate} ` +
              `${describeEdgeResponse(res.status, resHeaders)}`,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, transientRetryDelayMs(attempt, {
              retryAfterMs: retryAfterMs(resHeaders['retry-after']),
            })),
          );
          continue;
        }
        log.warn(
          `ke2e giving up ${routeTemplate} after ${attempt}/${maxAttempts} attempt(s) ` +
            `${describeEdgeResponse(res.status, resHeaders)}` +
            (replaySafe
              ? ''
              : ' — not replayed: the origin may have committed this create; ' +
                'the flow-level budget retries it against fresh fixtures') +
            (breakerOpen ? ` — ${transientBreaker.describe()}` : ''),
        );
      }
      return response;
    }

    throw new Error(`request attempt loop exhausted for ${method} ${url}`);
  }
}

/**
 * The api-router edge Worker launders any origin 5xx / fetch failure into a
 * synthetic MAINTENANCE_MODE 503 (worker.mjs, AUTOMATIC_MAINTENANCE). When the
 * request carries `X-Kortix-CI-Passthrough` matching the Worker's
 * CI_PASSTHROUGH_SECRET binding, the Worker returns the TRUE origin response
 * instead, so a release-gate failure is diagnosable. Opt-in via env so local
 * and unprivileged runs are unchanged. Exported for tests.
 */
export const CI_PASSTHROUGH_HEADER = 'x-kortix-ci-passthrough';
export function applyCiPassthrough(
  headers: Headers,
  secret: string | undefined = process.env.KE2E_CI_PASSTHROUGH_SECRET,
): void {
  const value = secret?.trim();
  if (!value) return;
  if (!headers.has(CI_PASSTHROUGH_HEADER)) headers.set(CI_PASSTHROUGH_HEADER, value);
}

function record(c: Captured): void {
  const rec = currentRecorder();
  if (rec) {
    rec.pushRequest(c);
    rec.routesHit.add(c.routeTemplate);
  }
}
