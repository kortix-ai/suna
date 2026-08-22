/**
 * Platinum implementation of `SandboxProviderAdapter`.
 *
 * Platinum templates ARE the "snapshots" (GET/DELETE /v1/templates). Building
 * does exactly what Daytona does — ship the staged build context (user
 * Dockerfile + Kortix runtime layer) to the provider and let it build
 * server-side. Daytona uses Image.fromDockerfile(); Platinum uses
 * `POST /v1/templates/from-build` (tar.gz of the same context staged by
 * snapshots/build-context.ts, so the produced image is identical). Platinum's
 * host then runs `podman build` + bakes its microVM init/agent, same as its
 * from-spec path.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  platinumJson,
  platinumJsonResponse,
  isPlatinumConfigured,
} from '../../shared/platinum';
import {
  stageAgentBinaryGz,
  DEFAULT_CPU,
  DEFAULT_MEMORY_GB,
  DEFAULT_DISK_GB,
  KORTIX_ENTRYPOINT,
  stageRuntimeBuildContext,
} from '../build-context';
import { SANDBOX_SPEC_LIMITS } from '../dockerfile-layer';
import { tarBuildContext } from '../staging-tar';
import { normalizeExistingProviderState } from './state';
import type {
  BuildableTemplate,
  BuildLogTap,
  BuildSnapshotResult,
  ProviderState,
  SandboxProviderAdapter,
} from './index';
import { shortLivedObservation } from '../observation-cache';
import {
  assertSafePresignedUploadUrl,
  parseUploadHostAllowlist,
  sanitizeUrlForLog,
} from './upload-url-guard';
import {
  classifyPlatinumPollError,
  isTerminalPollError,
  retryAfterMsFromError,
} from './platinum-poll-classify';
import { config } from '../../config';
import { materializePlatinumTemplate } from './platinum-materialize';

const ACTIVATE_DEADLINE_MS = 12 * 60 * 1000; // build + activate ceiling
const POLL_MS = 3_000;
const MB_PER_GB = 1024;
const BUILD_ATTEMPTS = 3;
const UPLOAD_ATTEMPTS = 3;
const UPLOAD_MIN_TIMEOUT_MS = 10 * 60_000;
const UPLOAD_TIMEOUT_MS_PER_GIB = 60_000;

async function materializeReadyTemplate(externalId: string) {
  return materializePlatinumTemplate(externalId, {
    enabled: config.KORTIX_FAST_COLD_BOOT_ENABLED,
    request: (path, init) => platinumJsonResponse(path, init),
  });
}
// Platinum's POST /v1/templates/from-build hard-caps size_mb at this value (see
// platinum apps/api/src/api/templates.ts ORG_MAX_SIZE_MB + the from-build zod).
// The build ext4 is a FLOOR Platinum grows-to-fit, so clamping the build ceiling
// does NOT shrink the runtime disk (default_disk_gb stays the full spec) — it only
// stops oversize-disk templates from being rejected with a raw "size_mb too_big"
// 400. Single source of truth for the build-size contract; keep in sync w/ Platinum.
export const PLATINUM_MAX_BUILD_SIZE_MB = 20480;
/** Floor for the PLATINUM_BUILD_SIZE_MB knob below — small enough that no real
 *  Kortix image could ever build into anything smaller, so a misconfigured
 *  knob can never clamp the build ceiling into a guaranteed-to-fail range. */
export const PLATINUM_MIN_BUILD_SIZE_MB = 1024;

/**
 * Build-ceiling env knob for `size_mb`, read LAZILY on EVERY call rather than
 * captured once as a module-load const. This module is imported ONCE and
 * shared across the whole `bun test` process (bun's module cache) — a
 * module-load const would freeze whichever suite's env happened to be set
 * first for every OTHER suite in the same run, making a const-based knob
 * untestable. build-context.ts's artifact-path consts document and abolish
 * the exact same anti-pattern for the same reason; this follows suit. Reading
 * `process.env` fresh per call is behaviour-neutral in production, where the
 * env is set once before the process starts.
 *
 * DEPLOY-NEUTRAL: the default is `PLATINUM_MAX_BUILD_SIZE_MB` itself — today's
 * effective ceiling — so shipping this knob changes NOTHING until an operator
 * explicitly sets `PLATINUM_BUILD_SIZE_MB` below the provider cap, after
 * verifying the Platinum build fleet supports grow-to-fit at that size.
 * Clamped to [PLATINUM_MIN_BUILD_SIZE_MB, PLATINUM_MAX_BUILD_SIZE_MB]: never
 * below a floor no real image could build into, never above Platinum's own
 * hard cap. A non-numeric or non-positive value is treated as unset (falls
 * back to the default) rather than producing a broken/zero build ceiling from
 * a typo'd env var.
 */
export function platinumBuildSizeMb(): number {
  const raw = Number(process.env.PLATINUM_BUILD_SIZE_MB);
  if (!Number.isFinite(raw) || raw <= 0) return PLATINUM_MAX_BUILD_SIZE_MB;
  return Math.min(PLATINUM_MAX_BUILD_SIZE_MB, Math.max(PLATINUM_MIN_BUILD_SIZE_MB, raw));
}

/** Distinct, greppable log/error token for the size-cap build-failure class —
 *  lets an operator search logs/Sentry for exactly this failure mode. */
export const PLATINUM_SIZE_CAP_LOG_TOKEN = 'PLATINUM_SIZE_CAP_EXCEEDED';

/**
 * A build ext4 ceiling too small for the image content — wrapped with
 * remediation naming the `PLATINUM_BUILD_SIZE_MB` env knob an operator would
 * raise, plus PLATINUM_SIZE_CAP_LOG_TOKEN, so this failure class is
 * recognizable in logs/Sentry without decoding a raw provider 400 body or an
 * opaque "build failed". NEVER retried (see isRetryablePlatinumBuildError,
 * isPlatinumSizeCapBuildFailure below) — the SAME content at the SAME ceiling
 * fails identically every time, so retrying only burns a BUILD_ATTEMPTS slot.
 */
export class PlatinumSizeCapBuildError extends Error {
  constructor(snapshotName: string, cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(
      `${PLATINUM_SIZE_CAP_LOG_TOKEN}: Platinum template ${snapshotName}'s build ext4 ceiling ` +
        `is too small for its image content and can never fit — raise the ` +
        `PLATINUM_BUILD_SIZE_MB env knob (clamped to [${PLATINUM_MIN_BUILD_SIZE_MB}, ` +
        `${PLATINUM_MAX_BUILD_SIZE_MB}]) or shrink the image, then rebuild. Original error: ` +
        `${causeMsg.slice(0, 300)}`,
    );
    this.name = 'PlatinumSizeCapBuildError';
  }
}

/**
 * True iff `err` is Platinum's HOST-SIDE terminal rejection of a build ext4
 * ceiling too small for the image content — either the `from-build`
 * registration's `400 size_mb too_big` (Platinum's from-build zod rejecting a
 * ceiling above its own cap) or an ENOSPC-shaped failure from the async
 * podman build itself outgrowing a ceiling an operator lowered below what the
 * image needs via PLATINUM_BUILD_SIZE_MB (only reachable once that knob is set
 * below today's deploy-neutral default — see platinumBuildSizeMb above). Both
 * are DETERMINISTIC "this size can never fit" failures, never transient.
 */
export function isPlatinumSizeCapBuildFailure(err: unknown): boolean {
  if (err instanceof PlatinumSizeCapBuildError) return true;
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    m.includes(PLATINUM_SIZE_CAP_LOG_TOKEN.toLowerCase()) ||
    m.includes('size_mb too_big') ||
    m.includes('template size cap') ||
    m.includes('enospc') ||
    m.includes('no space left on device')
  );
}

/**
 * Retry only stale-context (staging disturbed before the S3 upload — API restart
 * mid-build / tmp sweep) and transient transport (S3 PUT / gateway). A real build
 * failure ('template … build failed') is NOT retried — that's a genuine error,
 * not something a fresh stage would fix.
 *
 * One activate-timeout shape IS retried: `waitForActive` throwing "did not
 * become ready (last state: missing)" means the template NEVER appeared via
 * `GET /v1/templates` for the entire ACTIVATE_DEADLINE_MS poll window — not
 * "building", not "failed", just never registered at all. That is distinct
 * from an explicit 'failed' state (a genuine build error, never retried here)
 * and points at a registration-pipeline flake on Platinum's side rather than a
 * real build problem with this content. Verified empirically during a
 * 2026-07-18 dev incident: a `from-build` registration silently never
 * produced a template (stuck ~15min on `state: missing`, dev sandbox_id
 * 5771eb57-b0be-4579-8e33-93776a66f4fe), while a fresh build attempt for a
 * different content hash minutes later succeeded on its very first try — so a
 * same-process retry is a real, bounded (BUILD_ATTEMPTS) mitigation, not a
 * blind retry-forever. A build that reaches any OTHER observed state
 * ('building', 'pending', …) before failing is a real failure and still
 * excluded, same as 'failed'.
 */
export function isRetryablePlatinumBuildError(err: unknown): boolean {
  // A build ceiling too small for the image content can never fit — retrying
  // burns a BUILD_ATTEMPTS slot on an outcome that repeats identically. Checked
  // FIRST, ahead of the substring heuristics below, so this class is pinned
  // non-retryable even if a raw ENOSPC/too_big message happens to also contain
  // one of the transient substrings matched below (e.g. "network").
  if (isPlatinumSizeCapBuildFailure(err)) return false;
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // Platinum answers 429 for TWO opposite conditions, and only one is transient:
  //   - `rate_limited` (server.ts) — the per-org mutation-rate bucket
  //     (PT_ORG_MUT_RATE, 20 req/s). Transient; retrying is right.
  //   - `org_template_quota_exceeded` (api/templates.ts pickBuildHost) — the
  //     per-org COUNT cap on live templates (tiers 10/50/500). This does NOT
  //     self-clear: nothing frees a template row on its own, and Kortix has no
  //     org-wide GC for Platinum (snapshots/quota-gc.ts is Daytona-only — it
  //     imports listDaytonaSnapshots/deleteDaytonaSnapshotById exclusively). So
  //     burning BUILD_ATTEMPTS on it is pure delay in front of a wall, and it
  //     buries the one error an operator actually needs to see. Fail fast; the
  //     caller falls through to the cold path and the session still boots.
  if (m.includes('org_template_quota_exceeded')) return false;
  return (
    m.includes('does not exist') || m.includes('staging incomplete') || m.includes('scaffold') ||
    m.includes('no such file') || m.includes('s3 upload') || m.includes('tar build context') ||
    m.includes('timeout') || m.includes('timed out') || m.includes('econnreset') ||
    m.includes('econnrefused') || m.includes('network') || m.includes('gateway') ||
    m.includes(' 502') || m.includes(' 503') || m.includes(' 504') ||
    // Rate limiting is transient by definition — failing the build on a 429
    // re-queues the whole bake later, generating more traffic, not less.
    m.includes(' 429') || m.includes('too many requests') ||
    m.includes('last state: missing')
  );
}

interface PlatinumTemplate {
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

const productionPlatinumClient: PlatinumClient = {
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
async function paginateTemplates<R>(
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
async function fetchAllTemplates(
  client: PlatinumClient = productionPlatinumClient,
): Promise<PlatinumTemplate[]> {
  const { all } = await paginateTemplates(() => undefined, client);
  return all;
}

const observeTemplates = shortLivedObservation(
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
async function findTemplateById(
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
function isPlatinumAuthFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /-> (401|403)\b/.test(err.message);
}

/** 408 (S3 idle-timeout), our own AbortSignal timeout, and 5xx are transient
 *  — worth a fresh presign + retry. Anything else (400/401/403/404/...) is a
 *  real error and must NOT be retried. */
function isRetryableUploadError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const status = Number(err.message.match(/-> (\d{3})\b/)?.[1]);
  return status === 408 || status >= 500;
}

/**
 * Presigned-PUT build-context uploader, hardened against Scaleway S3's idle
 * timeout on large (100s-of-MB) contexts: a mid-transfer stall used to trip a
 * bare 408 with no retry, forcing a full re-upload (or failing the build
 * outright) further up in `isRetryablePlatinumBuildError`'s BUILD_ATTEMPTS
 * loop. Two things fix that here instead: (1) a per-attempt timeout scaled to
 * file size, so a genuinely-large upload isn't cut off before it could ever
 * finish; (2) on a transient failure (408 / timeout / 5xx), RE-PRESIGN for a
 * fresh `upload_url` + `context_s3_key` rather than retrying the same
 * (possibly already-consumed) presigned URL. The returned `context_s3_key` is
 * whichever attempt actually succeeded — callers MUST register that key, not
 * the one from their original presign call, or they'll upload to key A and
 * tell `from-build`/`from-patch` to look for key B.
 *
 * `presignFn()` itself is called INSIDE the try/catch (not before it): a
 * transient failure of the presign call (e.g. a 500/timeout from Platinum's
 * own `/v1/templates/from-build/presign`) is a real-world possibility, same
 * transport as the PUT, and must go through the same isRetryableUploadError
 * decision + retry loop — not bypass it and fail the whole upload on attempt 1.
 */
/**
 * Guard options for the presigned upload URL, derived from deployment env:
 *  - local-dev (`INTERNAL_KORTIX_ENV=dev`) allows http + loopback (MinIO),
 *  - `KORTIX_PLATINUM_UPLOAD_HOST_ALLOWLIST` pins the object-storage origin(s).
 * Exported so the uploader default and tests share one source of truth.
 */
export function uploadUrlGuardOptsFromEnv(): { allowLocal: boolean; allowedHosts: string[] } {
  return {
    allowLocal: config.INTERNAL_KORTIX_ENV === 'dev',
    allowedHosts: parseUploadHostAllowlist(process.env.KORTIX_PLATINUM_UPLOAD_HOST_ALLOWLIST),
  };
}

export async function uploadWithRetry(
  presignFn: () => Promise<{ upload_url: string; context_s3_key: string }>,
  tarPath: string,
  guardOpts: { allowLocal: boolean; allowedHosts: string[] } = uploadUrlGuardOptsFromEnv(),
): Promise<string> {
  const sizeBytes = Bun.file(tarPath).size;
  const timeoutMs = Math.max(UPLOAD_MIN_TIMEOUT_MS, Math.ceil((sizeBytes / 1024 ** 3) * UPLOAD_TIMEOUT_MS_PER_GIB));
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      const { upload_url, context_s3_key } = await presignFn();
      // PHASE 2: validate the presigned URL BEFORE streaming the context —
      // https-only outside local-dev, no loopback/link-local/private/multicast
      // SSRF targets, and origin-pinned when an allowlist is configured. An
      // invalid URL is NOT retryable (a fresh presign returns the same origin).
      let safeUrl: URL;
      try {
        safeUrl = assertSafePresignedUploadUrl(upload_url, guardOpts);
      } catch (guardErr) {
        // Wrap as a terminal (non-retryable) error — the sanitized message
        // never carries the presign signature.
        throw new UploadUrlRejectedError(guardErr instanceof Error ? guardErr.message : String(guardErr));
      }
      const put = await fetch(safeUrl, {
        method: 'PUT',
        body: Bun.file(tarPath),
        signal: AbortSignal.timeout(timeoutMs),
        // Refuse a 30x bounce of the signed PUT to a different origin.
        redirect: 'error',
      });
      if (put.ok) return context_s3_key;
      // Log only the sanitized URL (query/signature stripped).
      throw new Error(
        `build-context S3 upload -> ${put.status} ${(await put.text().catch(() => '')).slice(0, 200)} (${sanitizeUrlForLog(upload_url)})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isRetryableUploadError(err) || attempt === UPLOAD_ATTEMPTS) {
        throw new Error(`build-context upload failed after ${attempt}/${UPLOAD_ATTEMPTS} attempt(s): ${msg}`);
      }
      console.warn(`[snapshots] platinum build-context upload attempt ${attempt}/${UPLOAD_ATTEMPTS} failed — re-presigning + retrying: ${msg.slice(0, 160)}`);
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
  // Unreachable: the loop above always returns or throws by UPLOAD_ATTEMPTS.
  throw new Error('build-context upload failed');
}

/** A presigned upload URL that failed the security guard — terminal, never
 *  retried (a re-presign returns the same rejected origin/scheme). */
export class UploadUrlRejectedError extends Error {
  constructor(message: string) {
    super(`presigned upload URL rejected: ${message}`);
    this.name = 'UploadUrlRejectedError';
  }
}

const MALFORMED_BUILD_CAPACITY =
  'Malformed Platinum template build capacity: expected integer values with 0 <= templates.used <= templates.cap and templates.cap >= 1';
const MISSING_ATOMIC_ADMISSION =
  'Platinum template builds require the atomic template admission capability';

function parseSnapshotBuildCapacity(body: unknown): { used: number; cap: number } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(MALFORMED_BUILD_CAPACITY);
  }
  const templates = (body as Record<string, unknown>).templates;
  if (!templates || typeof templates !== 'object' || Array.isArray(templates)) {
    throw new Error(MALFORMED_BUILD_CAPACITY);
  }
  const { used, cap, atomicAdmission } = templates as Record<string, unknown>;
  if (
    typeof used !== 'number' ||
    typeof cap !== 'number' ||
    !Number.isSafeInteger(used) ||
    !Number.isSafeInteger(cap) ||
    used < 0 ||
    cap < 1 ||
    used > cap
  ) {
    throw new Error(MALFORMED_BUILD_CAPACITY);
  }
  if (atomicAdmission !== true) {
    throw new Error(MISSING_ATOMIC_ADMISSION);
  }
  return { used, cap };
}

export class PlatinumAdapter implements SandboxProviderAdapter {
  readonly id = 'platinum' as const;

  constructor(
    private readonly materializeTemplate: (
      externalId: string,
    ) => Promise<unknown> = materializeReadyTemplate,
    private readonly isPreparationEnabled: () => boolean = () =>
      config.KORTIX_FAST_COLD_BOOT_ENABLED,
    private readonly client: PlatinumClient = productionPlatinumClient,
  ) {}

  isConfigured(): boolean {
    return this.client.isConfigured();
  }

  async getSnapshotBuildCapacity(): Promise<{ used: number; cap: number }> {
    const body = await this.client.json<unknown>('/v1/auth/orgs/quota', { method: 'GET' });
    return parseSnapshotBuildCapacity(body);
  }

  async buildSnapshot(input: BuildableTemplate, tap?: BuildLogTap): Promise<BuildSnapshotResult> {
    if (!input.image && !input.userDockerfile) {
      throw new Error('PlatinumAdapter.buildSnapshot: neither image nor userDockerfile set');
    }
    const userDockerfile = input.userDockerfile ?? `FROM ${input.image}\n`;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= BUILD_ATTEMPTS; attempt++) {
      observeTemplates.invalidate();
      try {
        // Return the EXACT external template id the build proved
        // (requireExternalTemplateId inside buildOnce) — threaded to the caller
        // so the transition runner pins THAT id, never a name-list re-derivation.
        const result = await this.buildOnce(input, userDockerfile, tap);
        observeTemplates.invalidate();
        return result;
      } catch (err) {
        observeTemplates.invalidate();
        lastErr = err;
        if (!isRetryablePlatinumBuildError(err) || attempt === BUILD_ATTEMPTS) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[snapshots] platinum build attempt ${attempt}/${BUILD_ATTEMPTS} for ${input.snapshotName} failed — re-staging + retrying: ${msg.slice(0, 120)}`,
        );
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
      }
    }
    throw lastErr;
  }

  /** One build attempt: stage a FRESH context, ship it, register, wait active.
   *  Re-staged per attempt by buildSnapshot so a context disturbed between
   *  staging and the S3 upload self-heals (mirrors the daytona adapter). */
  private async buildOnce(input: BuildableTemplate, userDockerfile: string, tap?: BuildLogTap): Promise<BuildSnapshotResult> {
    // Stage the SAME context Daytona builds (Dockerfile + agent/cli/entrypoint/…).
    const ctx = await stageRuntimeBuildContext({
      snapshotName: input.snapshotName,
      userDockerfile,
      runtimeProfile: input.runtimeProfile,
      appContext: input.appContext,
      warmRepo: input.warmRepo,
      isShared: input.isShared,
    });
    const tarPath = join(ctx.contextDir, '..', `${input.snapshotName.replace(/[^a-zA-Z0-9_.-]/g, '_')}.tar.gz`);
    try {
      await tarBuildContext(ctx.contextDir, tarPath);

      // Contexts are 100s of MB (baked agent + CLI binaries) — too big for the
      // API gateway's body cap, so upload DIRECTLY to object storage via a
      // presigned PUT (phase 1 + 2), then register the build (phase 3). The
      // build itself still happens server-side on Platinum (podman build).
      console.info(`[snapshots] ${input.snapshotName}: presign + upload build context to Platinum (slug="${input.slug}")`);
      // STREAM the upload — Bun.file() sends the tarball in chunks, so a
      // 100s-of-MB context uploads in constant memory. The previous
      // new Uint8Array(await readFile()) buffered the ENTIRE tarball (twice) in
      // RAM and OOMKilled the 512Mi api pod (exit 137), 502-ing every session
      // whose request hit the crashing replica. Daytona never buffers — its SDK
      // streams the context — so this brings the Platinum path to parity.
      // uploadWithRetry re-presigns + retries on a transient S3 408/timeout/5xx
      // (see its doc comment) — context_s3_key below is whichever attempt won.
      const context_s3_key = await uploadWithRetry(
        () => this.client.json<{ upload_url: string; context_s3_key: string }>(
          '/v1/templates/from-build/presign', { method: 'POST', body: JSON.stringify({}) },
        ),
        tarPath,
      );

      const diskGb = Math.min(input.spec.diskGb ?? DEFAULT_DISK_GB, SANDBOX_SPEC_LIMITS.disk.max);

      const registered = await this.client.json<PlatinumTemplate>('/v1/templates/from-build', {
        method: 'POST',
        body: JSON.stringify({
          name: input.snapshotName,
          context_s3_key,
          dockerfile: ctx.dockerfileName,
          // Build-time ext4 ceiling — DECOUPLED from the runtime disk (default_disk_gb
          // below), which always stays the FULL spec: Platinum grows ext4 to fit, so
          // the artifact consumes only image+headroom (a ~9.4 GiB kortix image builds
          // fine into a 20 GiB ceiling). Three terms, each capping a different thing:
          // platinumBuildSizeMb() is the operator-tunable knob (env
          // PLATINUM_BUILD_SIZE_MB, default = PLATINUM_MAX_BUILD_SIZE_MB — i.e.
          // deploy-neutral until an operator explicitly lowers it); diskGb * MB_PER_GB
          // keeps a small-disk template's ceiling no larger than it needs; PLATINUM_
          // MAX_BUILD_SIZE_MB is Platinum's own from-build hard cap (>20 GiB-disk
          // without it 400s "size_mb too_big"). See isPlatinumSizeCapBuildFailure for
          // what happens when a ceiling this small can't fit the image.
          size_mb: Math.min(platinumBuildSizeMb(), diskGb * MB_PER_GB, PLATINUM_MAX_BUILD_SIZE_MB),
          default_cpu: input.spec.cpu ?? DEFAULT_CPU,
          default_ram_mb: (input.spec.memoryGb ?? DEFAULT_MEMORY_GB) * 1024,
          default_disk_gb: diskGb,
          entrypoint: (input.entrypoint ?? [KORTIX_ENTRYPOINT]).join(' '),
        }),
      });
      // PHASE 2 EXACT ID: from-build MUST hand back a non-empty template id. We
      // poll THAT id (never the truncated name list) — see waitForActive.
      const externalId = requireExternalTemplateId(registered?.id, `from-build for ${input.snapshotName}`);
      await waitForActive(input.snapshotName, tap, externalId, this.client);
      await this.materializeTemplate(externalId).catch((error) => {
        console.warn(
          `[snapshots] platinum materialize ${externalId}: fail-open guard caught ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      });
      // FIX-B: hand the EXACT proven id back to the caller (ppwarm → transition
      // runner) — no name-list re-derivation downstream.
      return { externalTemplateId: externalId };
    } catch (err) {
      // A too-small build ceiling is a DETERMINISTIC "this size can never fit"
      // failure — wrap it with remediation (naming PLATINUM_BUILD_SIZE_MB) and
      // the greppable log token BEFORE buildSnapshot's retry loop above sees it
      // via isRetryablePlatinumBuildError, so it's recognizable in logs without
      // decoding a raw provider 400 / opaque "build failed". Every other error
      // passes through unchanged.
      throw isPlatinumSizeCapBuildFailure(err) ? new PlatinumSizeCapBuildError(input.snapshotName, err) : err;
    } finally {
      await rm(ctx.contextDir, { recursive: true, force: true }).catch(() => {});
      await rm(tarPath, { force: true }).catch(() => {});
    }
  }

  /**
   * Agent-only fast path: build NEW snapshot from a PREDECESSOR snapshot by
   * swapping ONLY the kortix-agent binary inside its rootfs (no podman rebuild).
   * Ships just the agent .gz via the same presign path; the host debugfs-swaps it
   * into the predecessor's materialized rootfs + re-chunks (CAS delta). The caller
   * uses this ONLY when the user image is unchanged AND the predecessor is active
   * on Platinum — otherwise it falls back to a normal buildSnapshot.
   */
  async swapAgent(newSnapshotName: string, sourceSnapshotName: string): Promise<BuildSnapshotResult> {
    observeTemplates.invalidate();
    const { gzPath, cleanup } = await stageAgentBinaryGz();
    try {
      // uploadWithRetry — streamed + retried on transient S3 failure; see buildOnce.
      const context_s3_key = await uploadWithRetry(
        () => this.client.json<{ upload_url: string; context_s3_key: string }>(
          '/v1/templates/from-build/presign', { method: 'POST', body: JSON.stringify({}) },
        ),
        gzPath,
      );
      // Platinum's GENERAL file-patch primitive: patch our one changed file (the
      // kortix-agent binary) into the predecessor's rootfs — no rebuild. The guest
      // path is OURS to specify (Platinum is file-agnostic); /usr/local/bin/kortix-agent
      // is where our runtime layer (dockerfile-layer.ts) installs it. mode 0100755 =
      // executable (debugfs `write` lands 0644 otherwise).
      const patched = await this.client.json<PlatinumTemplate>('/v1/templates/from-patch', {
        method: 'POST',
        body: JSON.stringify({
          name: newSnapshotName,
          source_template_name: sourceSnapshotName,
          files: [{ s3_key: context_s3_key, guest_path: '/usr/local/bin/kortix-agent', mode: 0o100755 }],
        }),
      });
      // PHASE 2 EXACT ID: from-patch MUST return a non-empty id — poll it, never
      // the name list.
      const externalId = requireExternalTemplateId(patched?.id, `from-patch for ${newSnapshotName}`);
      await waitForActive(newSnapshotName, undefined, externalId, this.client);
      await this.materializeTemplate(externalId).catch((error) => {
        console.warn(
          `[snapshots] platinum materialize ${externalId}: fail-open guard caught ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      });
      // FIX-B: return the exact patched-template id (same contract as buildSnapshot).
      return { externalTemplateId: externalId };
    } finally {
      observeTemplates.invalidate();
      await cleanup();
    }
  }

  async getSnapshotState(snapshotName: string): Promise<ProviderState> {
    if (!this.client.isConfigured()) return 'missing';
    try {
      const template = await findTemplateByName(snapshotName, this.client);
      return template ? normalizeExistingProviderState(template.state) : 'missing';
    } catch (err) {
      // See isPlatinumAuthFailure's doc comment: a dead/revoked key must
      // propagate so callers (the provider-migration workflow) classify it as
      // PERMANENT, not silently degrade to 'unknown' → indeterminate → retry.
      if (isPlatinumAuthFailure(err)) throw err;
      return 'unknown';
    }
  }

  async findFirstActiveSnapshot(names: readonly string[]): Promise<string | null> {
    if (!this.client.isConfigured() || names.length === 0) return null;
    const priorities = new Map(names.map((name, index) => [name, index]));
    let bestIndex: number | null = null;
    const { early } = await paginateTemplates<string>(
      (page) => {
        for (const template of page) {
          const index = template.name ? priorities.get(template.name) : undefined;
          if (
            index !== undefined &&
            normalizeExistingProviderState(template.state) === 'active' &&
            (bestIndex === null || index < bestIndex)
          ) {
            bestIndex = index;
          }
        }
        // No later page can improve on the caller's first candidate.
        return bestIndex === 0 ? names[0] : undefined;
      },
      this.client,
    );
    return early ?? (bestIndex === null ? null : names[bestIndex]!);
  }

  async prepareSnapshot(snapshotName: string): Promise<void> {
    if (!this.isPreparationEnabled() || !this.client.isConfigured()) return;
    const template = await findTemplateByName(snapshotName, this.client);
    if (!template || normalizeExistingProviderState(template.state) !== 'active') return;
    const externalId = requireExternalTemplateId(template.id, `template lookup for ${snapshotName}`);
    await this.materializeTemplate(externalId);
  }

  /**
   * Resolve the EXACT Platinum template id backing a built snapshot name — the
   * durable "external_template_id" a provider-migration transition tracks (spec:
   * track by the id Platinum returns, not a truncated name listing). Best-effort
   * audit provenance: the AUTHORITATIVE readiness signal remains
   * getSnapshotState; a null here just means the id couldn't be resolved right
   * now (never a failure). Once #5207's by-id build wait lands, the build itself
   * already polls this id internally — this method only persists it for the
   * transition record + reconciler re-verification.
   */
  async getSnapshotExternalId(snapshotName: string): Promise<string | null> {
    if (!this.client.isConfigured()) return null;
    try {
      const template = await findTemplateByName(snapshotName, this.client);
      return template?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * PHASE 2 EXACT ID: verify readiness by the durable EXTERNAL template id (what
   * a transition persisted), not the name. `GET /v1/templates/:id` reads the
   * exact row Platinum created, so it can never miss it behind the 50-row
   * name-list pagination. A 404 = the id is gone → 'missing'. An auth failure
   * propagates (same rationale as getSnapshotState) so a dead key is classified
   * permanent rather than degraded to 'unknown'. Used by the reconciler to
   * re-verify an activated transition against its recorded id.
   */
  async getSnapshotStateByExternalId(externalId: string): Promise<ProviderState> {
    if (!this.client.isConfigured()) return 'missing';
    if (!externalId || externalId.trim() === '') return 'missing';
    try {
      const template = await findTemplateById(externalId, this.client);
      return template ? normalizeExistingProviderState(template.state) : 'missing';
    } catch (err) {
      if (isPlatinumAuthFailure(err)) throw err;
      return 'unknown';
    }
  }

  async deleteSnapshot(snapshotName: string): Promise<void> {
    if (!this.client.isConfigured()) return;
    observeTemplates.invalidate();
    try {
      const matches = (await fetchAllTemplates(this.client)).filter((template) => template.name === snapshotName);
      for (const template of matches) {
        try {
          await this.client.json(`/v1/templates/${template.id}`, { method: 'DELETE' });
        } catch (err) {
          // A lookup/delete race is equivalent to already gone. Provider
          // outages must propagate so fan-out reports this provider as failed.
          if (!/ -> 404(?:\s|$)/.test(err instanceof Error ? err.message : String(err))) {
            throw err;
          }
        }
      }
    } finally {
      observeTemplates.invalidate();
    }
  }

  async listSnapshots(): Promise<Array<{ name: string }>> {
    if (!this.client.isConfigured()) return [];
    // FIX-C: walk the FULL paginated list — the reaper needs every superseded
    // ppwarm image, not just the first 50 (created_at DESC), or an older tip past
    // page 1 lingers forever. A listing FAILURE throws (never returns a truncated
    // list the caller would mistake for "these are all the templates").
    return (await fetchAllTemplates(this.client))
      .map((template) => template.name)
      .filter((name): name is string => !!name)
      .map((name) => ({ name }));
  }
}

export const platinumProvider = new PlatinumAdapter();
