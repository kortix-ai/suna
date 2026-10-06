import { setTimeout as sleep } from 'node:timers/promises';
import { platinumJson, platinumJsonResponse, isPlatinumConfigured } from '../../shared/platinum';
import { normalizeExistingProviderState } from './state';
import type { BuildLogTap } from './index';
import { shortLivedObservation } from '../observation-cache';
import { classifyPlatinumPollError, isTerminalPollError, retryAfterMsFromError } from './platinum-poll-classify';

const ACTIVATE_DEADLINE_MS = 12 * 60 * 1000; // build + activate ceiling
const POLL_MS = 3_000;

export interface PlatinumTemplate {
  id: string;
  name?: string;
  state?: string;
  /** Echoed by /from-build since Platinum #1326; absent on an older API. */
  kernel_modules?: string;
  /** Redacted podman output. Only on the by-id detail row (the list strips it);
   *  a failed build ends it with `[build failed] <reason>`. */
  build_logs?: string | null;
  buildLogs?: string | null;
}

/**
 * Platinum reported `state: failed` for a template build. Carries the failing
 * lines of the build log so the error a user sees (`kortix sandboxes builds`,
 * the dashboard) names the step that broke instead of a bare "build failed" —
 * Platinum always had the cause in `build_logs`; we dropped it.
 *
 * A genuine build failure is deterministic, so this is NEVER retried (see
 * isRetryablePlatinumBuildError). The type — and the message prefix, for a
 * re-wrapped copy — is what keeps the appended log text (which may contain
 * words like "timeout" or "no such file") from flipping that decision.
 */
export class PlatinumTemplateBuildFailedError extends Error {
  readonly templateName: string;
  readonly detail: string;
  constructor(templateName: string, detail: string) {
    super(`Platinum template ${templateName} build failed${detail ? `: ${detail}` : ''}`);
    this.name = 'PlatinumTemplateBuildFailedError';
    this.templateName = templateName;
    this.detail = detail;
  }
}

/** Matches a (possibly re-wrapped) PlatinumTemplateBuildFailedError message. */
export const PLATINUM_BUILD_FAILED_RE = /platinum template \S+ build failed/i;

const FAILURE_DETAIL_MAX = 1_200;
const FAILURE_LINE_MAX = 400;
const ERRORISH_LINE = /\b(error|errors|failed|fatal|denied|cannot|can't|not found|no such|unable|invalid|exit status|exit code|killed|panic)\b/i;

/**
 * The few lines of a Platinum build log that explain a failure: the
 * error-looking lines just before Platinum's `[build failed] <reason>` trailer,
 * plus the trailer itself. Bounded (each line and the whole) because the
 * result becomes an error message stored on the build row and shown in UIs.
 */
export function summarizePlatinumBuildFailure(logs: string | null | undefined): string {
  const text = (logs ?? '').replace(/\r/g, '');
  if (!text.trim()) return '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const clip = (l: string) => (l.length > FAILURE_LINE_MAX ? `${l.slice(0, FAILURE_LINE_MAX)}…` : l);
  let trailer = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.startsWith('[build failed]')) { trailer = i; break; }
  }
  const end = trailer >= 0 ? trailer : lines.length;
  const window = lines.slice(Math.max(0, end - 25), end);
  // The giant "Error: building at STEP …" echo repeats the whole RUN line; the
  // trailer already names the step, so prefer the shorter, causal error lines.
  let picked = window.filter((l) => ERRORISH_LINE.test(l) && !/^Error: building at STEP/.test(l)).slice(-4);
  if (picked.length === 0) picked = window.slice(-3);
  const parts = [...picked, ...(trailer >= 0 ? [lines[trailer]!] : [])].map(clip);
  const joined = parts.join(' | ');
  return joined.length > FAILURE_DETAIL_MAX ? `${joined.slice(0, FAILURE_DETAIL_MAX)}…` : joined;
}

/** Best-effort: the failing build's log tail, from the polled row or its detail. */
async function failedBuildLogs(
  tpl: PlatinumTemplate | null,
  client: PlatinumClient,
): Promise<string> {
  const inline = tpl?.build_logs ?? tpl?.buildLogs;
  if (inline) return inline;
  if (!tpl?.id) return '';
  try {
    const detail = await findTemplateById(tpl.id, client);
    return detail?.build_logs ?? detail?.buildLogs ?? '';
  } catch {
    return ''; // the failure itself is already certain; the detail is a courtesy
  }
}

/**
 * Narrow Platinum API dependency used by template discovery and the adapter.
 * The production default delegates to the shared config-bound client. Tests can
 * inject an isolated client without mutating process-wide environment state.
 */
export interface PlatinumClient {
  isConfigured(): boolean;
  json<T>(path: string, init?: RequestInit): Promise<T>;
}

export const productionPlatinumClient: PlatinumClient = {
  isConfigured: () => isPlatinumConfigured(),
  json: <T>(path: string, init: RequestInit = {}) => platinumJson<T>(path, init),
};

/**
 * FIX-C: the template LIST endpoint (GET /v1/templates) is paginated (≤50 rows,
 * created_at DESC — see the module header). Reading only the first page turned an
 * older-but-live template on a >50-template org into a FALSE ABSENT → a needless
 * rebuild. We now walk every page and, critically, a page-fetch error OR the hard
 * page cap surfaces as PlatinumTemplateListingError (a listing FAILURE), NEVER as
 * absent: a `null` from findTemplateByName means "definitively not in the full
 * list", not "the listing errored". Callers that treat absent as "needs rebuild"
 * therefore never see a failed listing as a missing template.
 */
export class PlatinumTemplateListingError extends Error {
  constructor(message: string) {
    super(`platinum template listing failed: ${message}`);
    this.name = 'PlatinumTemplateListingError';
  }
}

/** Page size we request; the server default is also 50 (see module header). */
const TEMPLATES_PAGE_SIZE = 50;
/** Hard page cap so an API bug (an ignored/broken cursor) can NEVER spin forever.
 *  Hitting it with full, still-advancing pages is a listing FAILURE (throw), not
 *  an exhausted/absent list. The cap is a safety net, not a size limit: the
 *  Kortix Dev org held 1,671 templates on 2026-10-02 and grows ~70 a day, so a
 *  2,000 cap (the old 40) was weeks from making every full walk throw. */
const TEMPLATES_MAX_PAGES = 200; // 200 * 50 = 10,000 templates

async function fetchTemplatePage(
  offset: number,
  client: PlatinumClient,
  name?: string,
): Promise<PlatinumTemplate[]> {
  const nameParam = name === undefined ? '' : `&name=${encodeURIComponent(name)}`;
  const rows = await client.json<PlatinumTemplate[]>(
    `/v1/templates?limit=${TEMPLATES_PAGE_SIZE}&offset=${offset}${nameParam}`,
  );
  if (!Array.isArray(rows)) {
    throw new PlatinumTemplateListingError(`expected an array page, got ${typeof rows}`);
  }
  return rows;
}

/**
 * Walk /v1/templates pages (offset-paginated). `onPage` may return a non-undefined
 * value to EARLY-EXIT (name-scoped callers stop the moment the sought template
 * appears — most are recent → page 1). Pagination stops when a page is short/empty
 * (last page) OR adds no new template ids — a defensive cursor-loop guard: a server
 * that ignored `offset` would otherwise repeat page 0 forever, so we stop and
 * degrade to the first-page view rather than spin. A page-fetch error re-throws an
 * auth failure verbatim (401/403 stays classifiable) and wraps anything else as
 * PlatinumTemplateListingError; exceeding the hard page cap with full, distinct
 * pages likewise throws — never a silent truncation, never "absent".
 */
export async function paginateTemplates<R>(
  onPage: (page: PlatinumTemplate[], all: PlatinumTemplate[]) => R | undefined,
  client: PlatinumClient = productionPlatinumClient,
  /** Page 0, already fetched (an exact-name probe the control plane ignored). */
  firstPage?: PlatinumTemplate[],
): Promise<{ early: R | undefined; all: PlatinumTemplate[] }> {
  const all: PlatinumTemplate[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < TEMPLATES_MAX_PAGES; page++) {
    let rows: PlatinumTemplate[];
    try {
      rows =
        page === 0 && firstPage
          ? firstPage
          : await fetchTemplatePage(page * TEMPLATES_PAGE_SIZE, client);
    } catch (err) {
      // Preserve the 401/403 signature end to end (getSnapshotState rethrows it;
      // the transition classifier recognizes it as permanent). Everything else is
      // a listing FAILURE, surfaced as such — never swallowed into "absent".
      if (isPlatinumAuthFailure(err) || err instanceof PlatinumTemplateListingError) throw err;
      throw new PlatinumTemplateListingError(err instanceof Error ? err.message : String(err));
    }
    let newInPage = 0;
    for (const t of rows) {
      const key = typeof t.id === 'string' && t.id ? t.id : `name:${t.name ?? ''}`;
      if (!seen.has(key)) { seen.add(key); all.push(t); newInPage += 1; }
    }
    const early = onPage(rows, all);
    if (early !== undefined) return { early, all };
    if (rows.length < TEMPLATES_PAGE_SIZE) return { early: undefined, all }; // last page
    if (newInPage === 0) return { early: undefined, all }; // offset ignored → stop, don't spin
  }
  throw new PlatinumTemplateListingError(
    `exceeded ${TEMPLATES_MAX_PAGES} pages (> ${TEMPLATES_MAX_PAGES * TEMPLATES_PAGE_SIZE} templates) without exhausting the list`,
  );
}

/**
 * Every template named exactly `name`, newest first, via the control plane's
 * `GET /v1/templates?name=` filter: ONE request instead of a walk.
 *
 * Why it matters (measured 2026-10-02): the first session after each Kortix
 * deploy resolved its image through name lookups that walked the whole list.
 * The Kortix Dev org held 1,671 templates = 34 pages at ~250 ms each from
 * us-west-2 to the EU control plane, so `image:resolved` took 8.7 s.
 *
 * A control plane that predates the filter answers with the unfiltered first
 * page. That is detected (a row with another name) and returned as
 * `{ firstPage }`, so callers continue the classic walk from page 1 with the
 * exact number of requests they made before this helper existed.
 *
 * Errors keep `paginateTemplates`' contract: an auth failure propagates
 * verbatim, anything else is a PlatinumTemplateListingError, never "absent".
 */
export async function lookupTemplatesNamed(
  name: string,
  client: PlatinumClient = productionPlatinumClient,
): Promise<{ named: PlatinumTemplate[] } | { firstPage: PlatinumTemplate[] }> {
  const named: PlatinumTemplate[] = [];
  for (let page = 0; page < TEMPLATES_MAX_PAGES; page++) {
    let rows: PlatinumTemplate[];
    try {
      rows = await fetchTemplatePage(page * TEMPLATES_PAGE_SIZE, client, name);
    } catch (err) {
      if (isPlatinumAuthFailure(err) || err instanceof PlatinumTemplateListingError) throw err;
      throw new PlatinumTemplateListingError(err instanceof Error ? err.message : String(err));
    }
    if (rows.some((t) => t.name !== name)) {
      if (page === 0) return { firstPage: rows };
      throw new PlatinumTemplateListingError(
        `name filter for ${name} returned other templates past page 0`,
      );
    }
    named.push(...rows);
    if (rows.length < TEMPLATES_PAGE_SIZE) return { named };
  }
  throw new PlatinumTemplateListingError(
    `exceeded ${TEMPLATES_MAX_PAGES} pages of templates named ${name}`,
  );
}

/** Full paginated template list. Throws PlatinumTemplateListingError on a page
 *  error / cap-hit — a partial or failed listing is NEVER returned as a shorter
 *  (falsely-complete) list. */
export async function fetchAllTemplates(
  client: PlatinumClient = productionPlatinumClient,
): Promise<PlatinumTemplate[]> {
  const { all } = await paginateTemplates(() => undefined, client);
  return all;
}

export const observeTemplates = shortLivedObservation(
  () => fetchAllTemplates(),
  process.env.NODE_ENV === 'test' ? 0 : 2_000,
);

/**
 * Resolve a template by NAME across the FULL paginated list, early-exiting the
 * moment it appears. A `null` return means "walked the whole list, definitively
 * absent"; a listing FAILURE throws PlatinumTemplateListingError (or the raw
 * 401/403) — callers must NOT treat that as absent.
 */
export async function findTemplateByName(
  name: string,
  client: PlatinumClient = productionPlatinumClient,
): Promise<PlatinumTemplate | null> {
  const lookup = await lookupTemplatesNamed(name, client);
  if ('named' in lookup) return lookup.named[0] ?? null;
  const { early } = await paginateTemplates<PlatinumTemplate>(
    (page) => page.find((t) => t.name === name),
    client,
    lookup.firstPage,
  );
  return early ?? null;
}

/**
 * Direct GET /v1/templates/:id lookup — the PRIMARY signal `waitForActive`
 * polls once `from-build`/`from-patch` has handed back an id. Unlike the
 * name-list (`GET /v1/templates`, limit=50 created_at DESC — see the module
 * header), this reads the exact row Platinum just created, so it can never
 * miss it behind pagination. A 404 here is expected for a brief window right
 * after registration (the row can lag its own id becoming visible) — treat it
 * as "not ready yet", same as any other not-yet-ready state, and let the
 * caller's deadline (not this single lookup) decide when to give up.
 */
export async function findTemplateById(
  id: string,
  client: PlatinumClient = productionPlatinumClient,
): Promise<PlatinumTemplate | null> {
  try {
    return await client.json<PlatinumTemplate>(`/v1/templates/${id}`);
  } catch (err) {
    if (/ -> 404(?:\s|$)/.test(err instanceof Error ? err.message : String(err))) return null;
    throw err;
  }
}

const POLL_BACKOFF_BASE_MS = 2_000;
const POLL_BACKOFF_MAX_MS = 30_000;

/** Exponential backoff with full jitter for transient poll errors. */
function pollBackoffMs(streak: number): number {
  const ceil = Math.min(POLL_BACKOFF_MAX_MS, POLL_BACKOFF_BASE_MS * 2 ** Math.max(0, streak - 1));
  return Math.floor(Math.random() * ceil);
}

/**
 * Long-poll a just-registered template to `ready`. PRIMARY (and, per PHASE 2,
 * the ONLY) signal is `GET /v1/templates/:id` — a non-empty id from
 * `from-build`/`from-patch` is REQUIRED; the truncated name-list fallback is
 * gone (an idempotent-adopt can hand back an OLD row, and the list truncates at
 * 50, so a `ready` template can be absent from the page — a false "missing").
 *
 * Poll-error handling is classified (PHASE 2): 401/403 and TLS/cert failures
 * fail immediately (permanent); 404 is "not visible yet" (healthy, keep
 * polling); 429/5xx/DNS/socket/timeout are transient and retried with
 * exponential backoff + jitter (Retry-After honored on 429) WITHOUT counting
 * against anything — a long healthy `building` is not a failed attempt. Only an
 * explicit provider `failed` state, or the overall deadline, is terminal.
 *
 * When an id is polled, the resolved row's NAME is verified against `name`
 * (defense against an idempotent-adopt returning a different template).
 * Standalone (not a class method) so it's directly unit-testable.
 */
export async function waitForActive(
  name: string,
  tap?: BuildLogTap,
  id?: string,
  client: PlatinumClient = productionPlatinumClient,
): Promise<void> {
  const deadline = Date.now() + ACTIVATE_DEADLINE_MS;
  let last = 'unknown';
  let transientStreak = 0;
  while (Date.now() < deadline) {
    // Renew the caller's lease (if any) BEFORE polling. Placed OUTSIDE the poll
    // try/catch so a heartbeat that reports lost ownership (throws) STOPS the
    // wait rather than being swallowed as a transient poll error. The callback
    // itself swallows transient DB blips (see the drive's heartbeat wrapper), so
    // a throw here is an authoritative "you no longer own this" — the build we're
    // waiting on is now another owner's to finish.
    await tap?.heartbeat?.();
    let tpl: PlatinumTemplate | null;
    try {
      // findTemplateById returns null ONLY on an explicit 404 (not-visible-yet);
      // every other transport/HTTP error propagates here to be classified.
      tpl = id ? await findTemplateById(id, client) : await findTemplateByName(name, client);
      transientStreak = 0;
    } catch (err) {
      const cls = classifyPlatinumPollError(err);
      if (isTerminalPollError(cls)) {
        // 401/403 (dead key) or TLS/cert failure — fail NOW, preserving the
        // original classified message so the transition core marks it permanent.
        throw err instanceof Error ? err : new Error(String(err));
      }
      transientStreak += 1;
      const backoff = cls === 'rate-limited'
        ? (retryAfterMsFromError(err) ?? pollBackoffMs(transientStreak))
        : pollBackoffMs(transientStreak);
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      tap?.onLine?.(`template ${name}: transient poll error (${cls}) — retrying`);
      await new Promise((r) => setTimeout(r, Math.max(0, Math.min(backoff, remaining))));
      continue;
    }
    // A resolved-by-id row whose name doesn't match is an adopt mismatch, not
    // our build — fail closed rather than trust a wrong template.
    if (id && tpl && tpl.name && tpl.name !== name) {
      throw new Error(
        `Platinum template id ${id} resolved to name "${tpl.name}", expected "${name}" — refusing to trust a mismatched template`,
      );
    }
    const state = (tpl?.state ?? 'missing').toLowerCase();
    if (state !== last) { last = state; tap?.onLine?.(`template ${name}: ${state}`); }
    if (state === 'ready') return;
    if (state === 'failed') {
      const logs = await failedBuildLogs(tpl, client);
      if (logs) {
        for (const line of logs.replace(/\r/g, '').split('\n').filter((l) => l.trim()).slice(-40)) {
          tap?.onLine?.(line);
        }
      }
      throw new PlatinumTemplateBuildFailedError(name, summarizePlatinumBuildFailure(logs));
    }
    // building / pending / missing(=not-visible-yet) → healthy waiting.
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`Platinum template ${name} did not become ready (last state: ${last})`);
}

/** Assert a provider-returned external template id is present and non-empty —
 *  PHASE 2 EXACT ID: never fall back to the truncated name list. */
export function requireExternalTemplateId(id: unknown, context: string): string {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(
      `Platinum ${context} did not return a template id — refusing to fall back to name-list polling`,
    );
  }
  return id;
}

/**
 * Answers of `POST /v1/templates/:id/prepare` (Platinum #1381) that mean "not
 * resident yet, ask again". The copy state and the queue status are reported
 * independently: the control plane that runs a copy answers
 * `replicating`/`queued` until it finishes, and a failed copy past its cooldown
 * answers `failed`/`queued` when it is requeued. Only HTTP 200 with
 * `ready`/`ready` proves residency.
 */
const PREPARE_PENDING_STATES = new Set(['absent', 'replicating', 'failed']);
const PREPARE_PENDING_STATUSES = new Set(['queued', 'copying', 'cooling_down']);

/**
 * Make an exact, ready template resident in `region`'s object store and wait
 * until Platinum proves it (HTTP 200, `ready`). Throws on a deadline, on an
 * identity or region mismatch, and on any answer outside the prepare contract.
 * Platinum copies at most once per (template, region); repeated calls only
 * observe progress.
 */
export async function preparePlatinumTemplateRegion(
  snapshotName: string,
  region: string,
  opts: {
    client?: PlatinumClient;
    request?: typeof platinumJsonResponse;
    timeoutMs?: number;
  } = {},
): Promise<{ templateId: string; region: string }> {
  const timeoutMs = opts.timeoutMs ?? ACTIVATE_DEADLINE_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const client = opts.client ?? productionPlatinumClient;
  const request = opts.request ?? platinumJsonResponse;
  const callSignal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
  let lastState = 'resolving template';
  try {
    const template = await findTemplateByName(snapshotName, {
      isConfigured: () => client.isConfigured(),
      json: <T>(path: string, init: RequestInit = {}) => client.json<T>(path, { ...init, signal: callSignal() }),
    });
    const templateId = requireExternalTemplateId(template?.id, `lookup for ${snapshotName}`);
    while (!controller.signal.aborted) {
      const response = await request<{
        template_id?: unknown;
        region?: unknown;
        state?: unknown;
        status?: unknown;
        retry_after_ms?: unknown;
      }>(`/v1/templates/${encodeURIComponent(templateId)}/prepare`, {
        method: 'POST',
        body: JSON.stringify({ region }),
        signal: callSignal(),
      });
      controller.signal.throwIfAborted();
      const body = response.body;
      if (body.template_id !== templateId || body.region !== region) {
        throw new Error(`Platinum prepare identity/region mismatch for ${snapshotName} in ${region}`);
      }
      if (response.status === 200 && body.state === 'ready' && body.status === 'ready') {
        return { templateId, region };
      }
      const pending = response.status === 202
        && PREPARE_PENDING_STATES.has(String(body.state))
        && PREPARE_PENDING_STATUSES.has(String(body.status))
        && typeof body.retry_after_ms === 'number'
        && Number.isFinite(body.retry_after_ms) && body.retry_after_ms >= 0;
      if (!pending) {
        throw new Error(`Platinum prepare returned an invalid residency response for ${snapshotName} in ${region}`);
      }
      lastState = `${body.state}/${body.status}`;
      await sleep(Math.max(250, Math.min(body.retry_after_ms as number, 30_000)), undefined, {
        signal: controller.signal,
      });
    }
    throw new Error('prepare deadline elapsed');
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Platinum template ${snapshotName} did not become resident in ${region} within ${timeoutMs}ms (last state: ${lastState})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True iff `err` is a genuine auth/authorization failure from `platinumJson`
 * (`platinum <method> <path> -> 401 …` / `-> 403 …`) — a dead/revoked API key,
 * never a transient provider hiccup. Distinguishing this HERE (at the HTTP
 * layer) matters because `getSnapshotState` below used to swallow EVERY
 * lookup error into the generic `'unknown'` state, which the provider-
 * migration workflow's `interpretImageReadiness` correctly treats as
 * `'indeterminate'` (never "missing" — good) but which then gets reported to
 * `isPermanentTransitionError` as a plain, message-less
 * "provider state indeterminate" error — losing the 401/403 entirely, so a
 * dead key was misclassified as transient and retried for ~5 backed-off
 * attempts before dead-lettering with the WRONG error class (`exhausted`
 * instead of `auth_terminal`). Rethrowing ONLY this narrow, unambiguous class
 * preserves the original `platinumJson` message (which the transition core's
 * `isPermanentTransitionError` already recognizes via ' 401'/' 403') so an
 * auth failure fails FAST and CORRECTLY classified; every other lookup error
 * (network blip, 5xx, timeout) keeps the existing 'unknown' behavior so
 * session-boot and template-cache callers are unaffected.
 */
export function isPlatinumAuthFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /-> (401|403)\b/.test(err.message);
}
