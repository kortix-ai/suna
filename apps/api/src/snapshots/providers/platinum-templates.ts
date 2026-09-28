import { platinumJson, isPlatinumConfigured } from '../../shared/platinum';
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
 *  an exhausted/absent list. */
const TEMPLATES_MAX_PAGES = 40; // 40 * 50 = 2000 templates

async function fetchTemplatePage(
  offset: number,
  client: PlatinumClient,
): Promise<PlatinumTemplate[]> {
  const rows = await client.json<PlatinumTemplate[]>(
    `/v1/templates?limit=${TEMPLATES_PAGE_SIZE}&offset=${offset}`,
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
): Promise<{ early: R | undefined; all: PlatinumTemplate[] }> {
  const all: PlatinumTemplate[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < TEMPLATES_MAX_PAGES; page++) {
    let rows: PlatinumTemplate[];
    try {
      rows = await fetchTemplatePage(page * TEMPLATES_PAGE_SIZE, client);
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
  const { early } = await paginateTemplates<PlatinumTemplate>(
    (page) => page.find((t) => t.name === name),
    client,
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
    if (state === 'failed') throw new Error(`Platinum template ${name} build failed`);
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
