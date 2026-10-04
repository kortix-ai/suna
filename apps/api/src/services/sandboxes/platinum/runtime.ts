/**
 * Platinum sandbox provider.
 *
 * Provisions Cloud Hypervisor microVMs via the Platinum REST API. Mirrors the
 * Daytona provider's contract one-for-one; the only differences are Platinum's
 * request shapes:
 *   - create boots from a per-project TEMPLATE (opts.snapshot = a Platinum
 *     template id/name) with `?wait_for_state=running` so create returns a
 *     running sandbox synchronously (provisioning.async = false, like Daytona).
 *   - every port is reached through Platinum's edge via a PRIVATE expose: the
 *     edge requires the HMAC preview token, which the proxy carries in the
 *     `x-pt-preview-token` header (see resolveIngress). The agent port is also
 *     gated by the KORTIX serviceKey bearer (added in resolveEndpoint). Other
 *     ports, such as the static-file listener, have no in-box authentication,
 *     so the edge token is their only gate outside the Kortix proxy.
 *
 * S1 (idempotent create): a retry after an AMBIGUOUS transport failure
 * (timeout / dropped response) on the create POST must never blindly
 * re-POST — Platinum's CP could have already committed the box, and a second
 * POST would double the VM + its billing stream. Two layers close this,
 * both derived from the FULL 36-char `session_sandboxes.sandboxId` (never
 * `opts.name`, session-sandbox.ts's truncated `session-<8 chars>` display
 * name) plus a MONOTONIC `attempt` counter session-sandbox.ts persists +
 * restores across process restarts (see restorePlatinumCreateAttempt in
 * session-sandbox.ts):
 *   - PRIMARY: a deterministic `Idempotency-Key` header. Platinum's CP
 *     implements it (8-255 chars, scoped per actor+key): the SAME key with a
 *     semantically-identical body replays the already-committed sandbox
 *     (200, `replayed: true`); the SAME key with a genuinely different body
 *     is a 422 `idempotency_key_reused`; a key pointing at a terminal/deleted
 *     box is auto-skipped for a fresh create. retrySandboxProvisionCreate's
 *     own internal retry loop already re-calls create() on any transient
 *     failure — since the key (and the rest of the request body) stays
 *     IDENTICAL across those retries for one attempt, the CP's replay makes
 *     them safe with no special handling here.
 *   - SECONDARY/backstop: a deterministic `name` in the create body.
 *     Platinum's CP separately enforces per-org NAME uniqueness (409
 *     `name_taken`) — a human-debuggable belt-and-suspenders in case an
 *     idempotency record ever expires while the name index hasn't; see the
 *     409 handling in provisionFromTemplate. A name_taken that PERSISTS past
 *     the replay retry (the idempotency record really did expire, or
 *     `template` changed — buildIdempotencyKey folds it in, the name does
 *     not) advances to the NEXT attempt — a fresh name/key, exactly the
 *     transition heal/failover/id-boot-fallback already use in
 *     session-sandbox.ts — instead of throwing. The old box is NEVER touched:
 *     a prod org can carry tens of thousands of sandboxes (most `archived`,
 *     holding names indefinitely), so a by-name lookup is not viable on this
 *     path, and removing/starting a box this call cannot prove is
 *     unreferenced elsewhere is the orphan reaper's job. See provisionFromTemplate
 *     for the incident this closes.
 * Gated by KORTIX_PLATINUM_CREATE_DEDUP (default ON) for instant rollback —
 * off means the legacy body (no `name`, no header), unchanged from before.
 */

import type { SandboxExecOptions, SandboxExecResult } from '../../platform/providers/contract';
import { isProviderNotFound } from '../../platform/providers/status';
import { createHash } from 'node:crypto';
import { SANDBOX_VERSION, config } from '../../../lib/config';
import { currentInstanceId } from '../../sessions/instance-scope';
import { isOpencodePort } from '../../sessions/opencode-ports';
import { platinumJson, platinumJsonResponse, type PlatinumHttpError } from './client';
import { sandboxFrontendBaseUrl } from '../../platform/sandbox-frontend-url';
import { serviceKeyForExternalId } from '../../platform/service-key';
import type {
  CreateSandboxOpts,
  InPlaceRecoveryStatus,
  ProviderName,
  ProvisionResult,
  ProvisioningStatus,
  ProvisioningTraits,
  ResolvedEndpoint,
  ResolvedSandboxIngress,
  SandboxIngressRequest,
  SandboxProvider,
  SandboxStartOptions,
  SandboxStatus,
} from '../../platform/providers/contract';
import {
  SandboxTemplateNotFoundError,
  SnapshotStillBuildingError,
  assertWorkloadCredential,
  sandboxWorkloadType,
} from '../../platform/providers/contract';
import { providerAutoStopBackstopMinutes } from '../../platform/providers/contract';
import { classifyPtyWebSocketPath } from '../../platform/providers/pty-ingress';
import { sandboxOwnershipMarker } from '../../platform/sandbox-ownership';

const AGENT_PORT = 8000;
const START_CONFLICT_GRACE_MS = 30_000;
const START_CONFLICT_POLL_MS = 250;
/**
 * How long `stop()` waits for Platinum to confirm the VM actually powered
 * off, and the poll interval. Read per-call (not a module-load constant) so
 * tests can shrink both without an env var set before this module is first
 * imported.
 */
function stopConfirmDeadlineMs(): number {
  return Number(process.env.PLATINUM_STOP_CONFIRM_DEADLINE_MS) || 10_000;
}
function stopConfirmPollMs(): number {
  return Number(process.env.PLATINUM_STOP_CONFIRM_POLL_MS) || 500;
}
// Platinum holds /start on an archived box for up to 45 s while it restores the
// disk (UNARCHIVE_INLINE_WAIT_MS). The client's 20 s default abandoned that
// call before its 202 could arrive; give it the server's wait plus margin, as
// create() does for its 60 s long-poll.
export const START_CALL_TIMEOUT_MS = 60_000;
// How long start() carries a box through a restore from cold storage. A 6 GB
// session box restores in ~100 s alone on dev; observed slow restores take
// 546 s. Allow those restores to finish before the bounded wake expires.
export const START_RESTORE_BUDGET_MS = 10 * 60_000;
// How often a caller's lease is renewed (opts.onProgress) while a restore is
// seen in progress. The wake and restart leases run 240 s.
export const START_PROGRESS_INTERVAL_MS = 30_000;
const START_RESTORE_POLL_MS = 1_000;

interface PlatinumSandbox {
  id: string;
  state?: string;
  name?: string;
  /** Absent on Platinum builds before #1335. */
  autoResume?: boolean;
  /** Public region the box was placed in (e.g. 'eu-west', 'us-east'). */
  region?: string | null;
  /** The control plane that owns this box. services/sandboxes/platinum/client.ts learns it from
   *  this field (and from `x-pt-served-by`) and sends every later call by id
   *  straight there instead of through `PLATINUM_API_URL`'s forwarding hop. */
  api_url?: string;
  /** Set true by Platinum's CP when an Idempotency-Key replay resolved this
   *  response to an already-committed sandbox rather than a fresh create. */
  replayed?: boolean;
  backupState?: string | null;
  backup_state?: string | null;
  startedAt?: string | null;
  started_at?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string | null;
  createdAt?: string | null;
}

/** `GET /v1/sandboxes?paginated=true` — Platinum's list envelope. */
interface PlatinumSandboxPage {
  rows?: PlatinumSandbox[];
  total?: number;
  has_more?: boolean;
}
/**
 * A box created before `auto_resume: false` shipped (see create) still lets any
 * stray request wake it. The stop that parks it closes that, once, so no
 * backfill is needed: every box Kortix stops from now on is covered. Only when
 * Platinum reports the field — an older build reads a PATCH naming no field it
 * knows as "clear the name". Best effort: the stop itself already succeeded.
 */
async function disableAutoResume(externalId: string, sandbox: PlatinumSandbox | null): Promise<void> {
  if (sandbox?.autoResume !== true || sandbox.metadata?.['kortix.workload'] === 'app') return;
  await platinumJson(`/v1/sandboxes/${externalId}`, {
    method: 'PATCH',
    body: JSON.stringify({ auto_resume: false }),
  }).catch((err) =>
    console.warn(`[platinum] could not turn auto-resume off for ${externalId}:`, err instanceof Error ? err.message : err),
  );
}

type PlatinumExposedPort = { port: number; url: string; token?: string; public: boolean };

/**
 * The header Platinum's edge reads the HMAC preview token from
 * (`apps/edge/src/previewToken.ts` in the Platinum repo: `?t=`, then
 * `x-pt-token`, then `x-pt-preview-token`). A header composes with the proxy
 * appending a path and query; the `?t=` form in the expose URL does not.
 */
export const PLATINUM_PREVIEW_TOKEN_HEADER = 'x-pt-preview-token';

/**
 * Lifetime of a minted preview token. The proxy caches a resolved ingress for
 * five minutes (services/sandbox-proxy/backend.ts), so every cached token has a day of
 * validity left. Equal to Platinum's own default.
 */
const PREVIEW_TOKEN_TTL_SECONDS = 24 * 60 * 60;

/**
 * Split a private expose response into the bare edge origin and its token.
 * Platinum appends `?t=<token>` to a private URL; the proxy must not forward a
 * query of its own on every request, so the token moves to a header.
 */
export function privateEdgeIngress(exposed: PlatinumExposedPort): { url: string; token: string } {
  const raw = (exposed.url ?? '').trim();
  if (!raw) throw new Error(`[platinum] expose returned no URL for port ${exposed.port}`);
  const parsed = new URL(raw);
  const token = exposed.token || parsed.searchParams.get('t') || '';
  if (!token) {
    throw new Error(`[platinum] private expose returned no preview token for port ${exposed.port}`);
  }
  parsed.searchParams.delete('t');
  parsed.hash = '';
  const url = parsed.toString().replace(/\?$/, '').replace(/\/$/, '');
  return { url, token };
}

/** Ports a Platinum sandbox row records as exposed without a token. */
export function publicExposedPorts(sandbox: {
  metadata?: Record<string, unknown> | null;
}): number[] {
  const exposures = (sandbox.metadata?.exposures ?? null) as
    | Record<string, { public?: unknown } | null>
    | null;
  if (!exposures || typeof exposures !== 'object') return [];
  const ports: number[] = [];
  for (const [key, value] of Object.entries(exposures)) {
    const port = Number(key);
    if (Number.isInteger(port) && port > 0 && value?.public === true) ports.push(port);
  }
  return ports.sort((a, b) => a - b);
}

/**
 * Sandboxes whose public exposures this process has already converted to
 * private. Bounded: an entry only saves one GET, so eviction is harmless.
 */
const hardenedExposureSandboxes = new Set<string>();
const HARDENED_EXPOSURE_CACHE_MAX = 20_000;
type PlatinumExecResponse = {
  result?: {
    stdout?: string;
    stderr?: string;
    exit_code?: number;
    error?: string;
  };
  error?: string;
};

/**
 * FIX-A: a DEFINITIVE "pinned template is gone" signal — a 404 on the create
 * POST (the template id doesn't exist / was GC'd). ONLY a 404 qualifies: a 400
 * (bad request) or 5xx (transient outage) is NOT a GC'd pin and must NOT trigger
 * a name-boot fallback.
 */
function isDefinitiveTemplateNotFound(error: unknown): boolean {
  return platinumHttp(error).status === 404;
}

/** The `status`, `code` and `body` of the `PlatinumHttpError` `platinumJson` throws. */
function platinumHttp(error: unknown): Partial<Pick<PlatinumHttpError, 'status' | 'code' | 'body'>> {
  return error instanceof Error ? (error as Partial<PlatinumHttpError>) : {};
}

/**
 * Whether the orphan-box reaper may treat a listed provider box as this
 * instance's. Stricter than `sandboxBelongsToThisInstance`, which keeps an
 * UNSTAMPED database row everyone's: that rule is safe for a row, because the
 * row is in this instance's own database. A provider box is not. Every PR
 * preview shares one Platinum org and one `kortix.env=preview` tag, each with
 * its own database, and a box a preview created before the stamp existed has
 * no row here. Counting it as ours would let one preview's orphan reaper stop
 * another preview's live sessions. So, when this instance has an id, only a box
 * that carries exactly that id is ours.
 */
export function providerBoxBelongsToThisInstance(stamped: unknown): boolean {
  const mine = currentInstanceId();
  if (!mine) return stamped === undefined || stamped === null;
  return typeof stamped === 'string' && stamped === mine;
}

/**
 * S1 kill-switch — the create-dedup name + Idempotency-Key. Default ON. Set
 * KORTIX_PLATINUM_CREATE_DEDUP=0/off/false/no to instantly revert to the
 * legacy create body (no `name`, no `Idempotency-Key` header) if the CP-side
 * idempotency behavior ever needs to be ruled out during an incident.
 */
export function platinumCreateDedupEnabled(): boolean {
  const raw = (process.env.KORTIX_PLATINUM_CREATE_DEDUP ?? '').trim().toLowerCase();
  if (raw === '') return true; // default ON
  return !(raw === '0' || raw === 'off' || raw === 'false' || raw === 'no');
}

const SANDBOX_NAME_MAX_LEN = 63;
const SANDBOX_NAME_CHARSET = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Deterministic per-(sandboxId, attempt) sandbox name — the SECONDARY,
 * human-debuggable dedup layer (see module doc). `kortix-` (7) + a 36-char
 * UUID + `-a<n>` is always well under the 63-char limit for any realistic
 * attempt count, and every character UUIDs/`-`/`a`/digits produce is already
 * legal, so the fallback below is defensive rather than reachable today —
 * kept so create() can never send an invalid name if either shape changes.
 * The fallback hashes the FULL raw identity (never truncates it) so two
 * different (sandboxId, attempt) pairs can't collide onto the same name.
 */
function buildDeterministicSandboxName(sandboxId: string, attempt: number): string {
  const raw = `kortix-${sandboxId}-a${attempt}`;
  if (raw.length <= SANDBOX_NAME_MAX_LEN && SANDBOX_NAME_CHARSET.test(raw)) return raw;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 32);
  return `kortix-${hash}`;
}

/**
 * Deterministic Idempotency-Key — the PRIMARY dedup layer (see module doc).
 * `|`-joined so the three components can never accidentally concatenate into
 * an ambiguous value (e.g. a template id ending in a digit run into the
 * attempt number). Always a 64-char hex string, comfortably inside Platinum's
 * 8-255 char bound.
 */
function buildIdempotencyKey(sandboxId: string, templateId: string, attempt: number, region?: string): string {
  // The region joins the key only when one is asked for, so every existing
  // no-region session keeps the exact key it had before regions existed.
  const regionPart = region ? `|r${region}` : '';
  return createHash('sha256').update(`${sandboxId}|${templateId}|a${attempt}${regionPart}`).digest('hex');
}

/**
 * Platinum refuses a create in a region that does not hold the template yet:
 * `409 template_not_resident`, with `state` 'absent', 'replicating' or
 * 'failed'. Platinum copies the template there on its own (the copy's progress
 * is what `state` reports), so this is the "image still building" condition in
 * another form, and it gets the same patient retry window: it throws the
 * `SnapshotStillBuildingError` that sandbox-init-state.ts waits out.
 */
function regionalTemplateNotReady(error: unknown, template: string): Error | null {
  const http = platinumHttp(error);
  if (http.status !== 409 || http.code !== 'template_not_resident') return null;
  let body: { region?: unknown; state?: unknown } = {};
  try {
    body = JSON.parse(http.body ?? '') as typeof body;
  } catch {
    // code parsed from this body, so it is JSON; keep the defaults if not
  }
  const region = typeof body.region === 'string' ? body.region : 'the requested region';
  const state = typeof body.state === 'string' ? body.state : 'absent';
  return new SnapshotStillBuildingError(
    `Sandbox image snapshot ${template} is building in ${region}: Platinum is copying the template there (state=${state})`,
  );
}

/**
 * A definitive 409 whose body signals the deterministic NAME is already
 * taken. Because the name is derived solely from (sandboxId, attempt) and
 * never reused across sandboxes/attempts, the only way Platinum can already
 * have it is that OUR OWN earlier POST for this exact attempt already
 * committed — normally after an ambiguous transport failure on that earlier
 * POST that also left the Idempotency-Key record unresolved on our side (see
 * provisionFromTemplate's handling: re-POST the SAME body under the SAME
 * key, which the CP replays to the already-committed box).
 */
function isNameTakenConflict(error: unknown): boolean {
  const http = platinumHttp(error);
  return http.status === 409 && http.code === 'name_taken';
}

export class PlatinumProvider implements SandboxProvider {
  readonly name: ProviderName = 'platinum';

  readonly provisioning: ProvisioningTraits = {
    async: false,
    stages: [{ id: 'creating', progress: 50, message: 'Creating sandbox...' }],
  };

  async getProvisioningStatus(): Promise<ProvisioningStatus | null> {
    return null;
  }

  async create(opts: CreateSandboxOpts): Promise<ProvisionResult> {
    // Boot from the session's own per-project template if one was built
    // (opts.snapshot), else fall back to the fixed PLATINUM_TEMPLATE (e.g.
    // kortix-computer) — so Platinum works out of the box without a per-project
    // build. At least one must be set.
    const template = opts.snapshot ?? config.PLATINUM_TEMPLATE;
    if (!template) {
      throw new Error(
        'Platinum create() has no template: pass opts.snapshot or set PLATINUM_TEMPLATE ' +
        '(a ready Platinum template id, e.g. kortix-computer).',
      );
    }
    return this.provisionFromTemplate(template, opts);
  }

  /**
   * FIX-A: boot from an EXACT pinned template id (the activation-recorded
   * `active_sandbox_external_template_id`). Same POST /v1/sandboxes provisioning
   * as create() — the only difference is error classification: a DEFINITIVE 404
   * (the pinned id was GC'd) becomes {@link SandboxTemplateNotFoundError} so the
   * boot path can fall back to a name-boot; a transient 5xx (or any other error)
   * propagates UNCHANGED so it is surfaced/retried, never silently name-booted.
   */
  async createFromExternalId(
    externalTemplateId: string,
    opts: CreateSandboxOpts,
  ): Promise<ProvisionResult> {
    if (!externalTemplateId || externalTemplateId.trim() === '') {
      throw new Error('[platinum] createFromExternalId called without a template id');
    }
    try {
      return await this.provisionFromTemplate(externalTemplateId, opts);
    } catch (err) {
      if (isDefinitiveTemplateNotFound(err)) {
        throw new SandboxTemplateNotFoundError(
          `[platinum] pinned template ${externalTemplateId} not found (404) — GC'd pin`,
        );
      }
      throw err;
    }
  }

  private async provisionFromTemplate(
    template: string,
    opts: CreateSandboxOpts,
  ): Promise<ProvisionResult> {
    const _t0 = Date.now();
    const workloadType = sandboxWorkloadType(opts);
    const sandboxApiBase = config.KORTIX_URL
      .replace(/\/+$/, '')
      .replace(/\/v1\/router$/, '')
      .replace(/\/v1$/, '');

    const envVars: Record<string, string> = {
      KORTIX_API_URL: `${sandboxApiBase}/v1`,
      // Frontend base for user-facing dashboard links (never the API host).
      KORTIX_FRONTEND_URL: sandboxFrontendBaseUrl(),
      ...(workloadType === 'app' ? { KORTIX_WORKLOAD_TYPE: workloadType } : {}),
      ...opts.envVars,
    };
    assertWorkloadCredential(this.name, opts, envVars);

    // autoStopInterval maps to Platinum's auto_stop_minutes. 0 → persistent
    // (never auto-stops); >0 → ephemeral with that idle timeout.
    //
    // Platinum AUTO-STOPS idle boxes natively and resumes them CoW on reopen
    // (the CH UFFD resume bug that once forced persistent is fixed; verified
    // stop→resume ~2.3s). Its native timer is the BACKSTOP for when this API is
    // dead — `deadline_at` (services/sandboxes/sandbox-deadline.ts) is the primary stop, so
    // the native interval sits well above the longest real turn and never kills a
    // box mid-work. See providerAutoStopBackstopMinutes(), which is now that
    // policy alone and no longer doubles as the billing clamp's grace.
    const autoStop = opts.autoStopInterval ?? providerAutoStopBackstopMinutes();

    // ── S1: create-side dedup identity (see module doc for the full design) ──
    // `attempt` is session-sandbox.ts's MONOTONIC, persisted counter — stable
    // across retrySandboxProvisionCreate's own internal retry loop (an
    // "ambiguous retry" of THIS attempt), advancing only when session-sandbox
    // decides this is a genuinely new attempt. Defaults to 1 for any caller
    // that doesn't thread it (keeps this safe/inert for direct callers).
    const dedupAttempt = opts.createAttempt ?? 1;
    const dedup =
      platinumCreateDedupEnabled() && opts.sandboxId
        ? {
            name: buildDeterministicSandboxName(opts.sandboxId, dedupAttempt),
            idempotencyKey: buildIdempotencyKey(opts.sandboxId, template, dedupAttempt, opts.location),
            sandboxId: opts.sandboxId,
          }
        : null;

    const createBody: Record<string, unknown> = {
      template,
      envVars,
      type: autoStop === 0 ? 'persistent' : 'ephemeral',
      auto_stop_minutes: autoStop,
      // Only Kortix wakes a session box. Platinum's edge resumes a stopped VM on
      // ANY inbound request, and Kortix keeps sending some after a stop (5-min
      // cached edge URLs, an SSE reconnect, a retry). The VM then ran while our
      // row said `stopped`, its session credential refused: 68 prod boxes in
      // one day, one left serving nothing for 18 h (2026-09-28). Apps keep the
      // default: a visitor's request is supposed to wake them. Platinum builds
      // before #1335 drop the unknown field (non-strict schema).
      auto_resume: workloadType === 'app',
      // The project's `us_region` flag (services/platform/services/sandbox-region.ts).
      // Absent ⇒ Platinum places the box in its home region, exactly as
      // before. A create for a region this process has already seen a box in
      // goes straight to that region's control plane; otherwise
      // PLATINUM_API_URL forwards it there. The answer names the owner
      // (`api_url`), and every later call by id goes straight to it
      // (services/sandboxes/platinum/client.ts).
      ...(opts.location ? { region: opts.location } : {}),
      // Database + instance ownership. The versioned marker also excludes
      // these boxes from older clients' environment-wide orphan sweeps.
      metadata: {
        'kortix.managed': await sandboxOwnershipMarker(),
        'kortix.env': config.INTERNAL_KORTIX_ENV,
        'kortix.workload': workloadType,
        ...(opts.sandboxId ? { 'kortix.sandbox_id': opts.sandboxId } : {}),
        // Instance scope (services/sessions/instance-scope.ts): `listManagedRunningSandboxes`
        // skips another instance's boxes. Set by local dev worktrees and by PR
        // previews, where it names the preview host that owns this session box
        // (tests/src/core/preview-session-reaper.ts). Absent in deployed
        // environments.
        ...(currentInstanceId() ? { 'kortix.instance': currentInstanceId()! } : {}),
      },
    };
    if (dedup) {
      createBody.name = dedup.name;
    }
    const createBodyJson = JSON.stringify(createBody);
    const CREATE_PATH = '/v1/sandboxes?wait_for_state=running&wait_timeout_ms=60000';
    // This asks Platinum to long-poll server-side for up to 60s
    // (wait_timeout_ms) — platinumJson's default 20s client-side abort budget
    // would cut that off early, so pass an explicit signal comfortably longer
    // than the server-side wait instead of relying on the default.
    const postCreate = () =>
      platinumJson<PlatinumSandbox>(CREATE_PATH, {
        method: 'POST',
        signal: AbortSignal.timeout(70_000),
        body: createBodyJson,
        ...(dedup ? { headers: { 'Idempotency-Key': dedup.idempotencyKey } } : {}),
      });

    const _tCreate0 = Date.now();
    let sandbox: PlatinumSandbox;
    // S1 FOLLOW-UP (prod incident 2026-09-27): the attempt actually committed,
    // for the caller to persist. Equals `dedupAttempt` unless the advance
    // branch below fires. Never touched when `dedup` is off.
    let committedAttempt = dedupAttempt;
    try {
      sandbox = await postCreate();
    } catch (err) {
      const notYetInRegion = regionalTemplateNotReady(err, template);
      if (notYetInRegion) throw notYetInRegion;
      if (!dedup || !isNameTakenConflict(err)) throw err;
      // See isNameTakenConflict + the module doc: the name is exclusively
      // ours, so this can only be our own prior commit under this same
      // attempt. Re-issue the IDENTICAL body under the SAME key once — the
      // CP resolves it to a replay of the already-committed box rather than
      // a second create.
      console.warn(
        `[platinum] name_taken for ${dedup.name} (sandboxId=${opts.sandboxId}, attempt=${dedupAttempt}) — ` +
        `retrying under the SAME Idempotency-Key to replay the committed box instead of a fresh create:`,
        err,
      );
      try {
        sandbox = await postCreate();
      } catch (err2) {
        if (!isNameTakenConflict(err2)) throw err2;
        // The replay assumption above just failed — the SAME Idempotency-Key
        // still hit a genuine conflict, which only happens when Platinum's
        // idempotency record for it expired, or `template` changed since the
        // box under this name was first committed (buildIdempotencyKey folds
        // template in, the name does not — see the module doc). The box
        // holding `dedup.name` is NEVER touched here — a prod org can carry
        // tens of thousands of sandboxes (most `archived`, holding names
        // indefinitely under Platinum's `deleted_at IS NULL` uniqueness
        // predicate), so a by-name lookup is not a viable create-path
        // operation, and removing/starting a box this call cannot prove is
        // unreferenced elsewhere is the orphan reaper's job, not create()'s.
        //
        // Advance to the NEXT attempt instead — a fresh deterministic name +
        // Idempotency-Key, exactly the transition heal/provider-failover/
        // id-boot-fallback already use in session-sandbox.ts. Bounded to ONE
        // advance per call: if that also 409s name_taken, throw rather than
        // ever advancing again. The caller persists `committedAttempt` via
        // this method's return metadata, so the NEXT top-level `/start`
        // reads the ADVANCED attempt (restorePlatinumCreateAttempt) and never
        // re-hits this same stuck name — closing the prod incident where
        // nothing ever advanced the counter and the identical name/key
        // 409'd forever on a ~15-minute retry cadence.
        const advancedAttempt = dedupAttempt + 1;
        const advancedName = buildDeterministicSandboxName(dedup.sandboxId, advancedAttempt);
        const advancedKey = buildIdempotencyKey(dedup.sandboxId, template, advancedAttempt, opts.location);
        console.warn(
          `[platinum] name_taken PERSISTED for ${dedup.name} after the replay retry — ` +
          `advancing to attempt ${advancedAttempt} (fresh name ${advancedName}), never touching the old box:`,
          err2,
        );
        try {
          sandbox = await platinumJson<PlatinumSandbox>(CREATE_PATH, {
            method: 'POST',
            signal: AbortSignal.timeout(70_000),
            body: JSON.stringify({ ...createBody, name: advancedName }),
            headers: { 'Idempotency-Key': advancedKey },
          });
        } catch (err3) {
          if (!isNameTakenConflict(err3)) throw err3;
          throw new Error(
            `[platinum] name_taken persisted for ${dedup.name} even after advancing to attempt ` +
            `${advancedAttempt} (${advancedName}) — refusing to advance again`,
          );
        }
        committedAttempt = advancedAttempt;
      }
    }
    const _vmMs = Date.now() - _tCreate0;

    const externalId = sandbox.id;

    // `?wait_for_state=running` returns 200 with the sandbox body even when the
    // box reached a TERMINAL-FAIL state (failed-start / lost / deleted) — the
    // wait helper on the Platinum side stops early on those but does NOT error
    // (apps/api/src/api/sandboxes.ts maybeWait). So a create can hand back an id
    // for a DEAD box. Before this guard we read `sandbox.id` and marched on, so
    // an intermittent guest-boot stall surfaced as a "running" session that was
    // actually failed-start (proven 2026-07-07 on one session: Platinum
    // state=failed-start, comp status=active). Throw on a non-running terminal
    // state so retrySandboxProvisionCreate re-attempts (fresh box, possibly
    // another host) instead of silently returning an unusable sandbox. The
    // host-agent also relaunches the guest in-place once, so this retry is the
    // outer backstop for the rare case both in-host attempts stall.
    const createdState = String(sandbox.state ?? '').toLowerCase();
    // Only a TERMINAL-fail state is a definite dead box (mirrors the Platinum
    // maybeWait TERMINAL_FAIL_STATES set). 'provisioning' here means the wait
    // timed out on a still-booting box — rare, and the FE readiness poll can
    // still pick it up — so don't tear that down.
    const TERMINAL_FAIL = new Set(['failed-start', 'lost', 'deleted']);
    if (TERMINAL_FAIL.has(createdState)) {
      // Best-effort remove the dead box so it doesn't linger/eat capacity; the
      // retry provisions a fresh one.
      await this.remove(externalId).catch(() => {});
      throw new Error(
        `[platinum] sandbox ${externalId} did not reach running (state=${createdState}) after ${_vmMs}ms`,
      );
    }

    const ingressPort = workloadType === 'app' ? 8080 : AGENT_PORT;
    const baseUrl = `${sandboxApiBase}/v1/p/${externalId}/${ingressPort}`;

    // Eagerly expose the agent port so the *.sbx edge route is LIVE the moment
    // the sandbox is running — before the FE connects. Expose is otherwise lazy
    // (first /v1/p request triggers it), which left a window where the FE's
    // /agent, /session, /global/events calls hit an un-routed edge → 504s right
    // after runtime-ready. Best-effort: a failure here just falls back to the
    // lazy expose in resolveEndpoint.
    let exposedUrl = '';
    const _tExpose0 = Date.now();
    try {
      const exposed = await platinumJson<PlatinumExposedPort>(
        `/v1/sandboxes/${externalId}/expose`,
        {
          method: 'POST',
          body: JSON.stringify({
            port: ingressPort,
            public: false,
            ttl_seconds: PREVIEW_TOKEN_TTL_SECONDS,
          }),
        },
      );
      exposedUrl = (exposed.url ?? '').replace(/\/$/, '');
    } catch (err) {
      console.warn(
        `[platinum] eager expose ${externalId}:${AGENT_PORT} failed (lazy fallback):`,
        err,
      );
    }
    const _exposeMs = Date.now() - _tExpose0;

    // Return as soon as the VM is running and the agent port is exposed — do NOT
    // block on the in-guest runtime (repo clone + opencode). That readiness is
    // polled by the frontend (useOpenCodeRuntimeReady + the react-query
    // "opencode not ready" retry) EXACTLY as it is for Daytona, whose create()
    // also returns a not-yet-usable box and defers readiness to the FE.
    //
    // Why this matters: the old code polled /kortix/health for runtimeReady up
    // to 75s here. Under a restored-VM virtio-net RX stall the clone can hang,
    // so that poll burned the full 75s and surfaced as the dreaded provision
    // timeout. Returning at vm-running makes the 75s timeout IMPOSSIBLE (we never
    // poll) and — since a Platinum restore resumes in ~50ms — create() returns in
    // ~1s, FASTER than Daytona's cloud-start. The daemon's clone-retry +
    // transfer-stall-timeout (kortix-sandbox-agent-server) recover any transient
    // clone stall in the background while the FE waits, so the session still
    // becomes usable without any create-path hang.
    console.log(
      `[platinum-timing] ${externalId} ` +
        `vm-running=${_vmMs}ms expose=${_exposeMs}ms ` +
        `edge=${exposedUrl ? 'ready' : 'lazy'} total=${Date.now() - _t0}ms (runtime-ready deferred to FE poll, like daytona)` +
        (sandbox.replayed ? ' [S1: Idempotency-Key replay — adopted an already-committed box]' : ''),
    );

    return {
      externalId,
      baseUrl,
      metadata: {
        provisionedBy: opts.userId,
        platinumSandboxId: externalId,
        template,
        version: SANDBOX_VERSION,
        workloadType,
        // Where Platinum actually placed the box, from its answer — not what
        // we asked for — so an operator reading the session row sees the truth.
        ...(sandbox.region ? { platinumRegion: sandbox.region } : {}),
        ...(sandbox.api_url ? { platinumApiUrl: sandbox.api_url } : {}),
        // Persisted into session_sandboxes.metadata by the caller
        // (buildSandboxInitSuccessMetadata spreads this in verbatim) so a
        // LATER top-level provisioning call's restorePlatinumCreateAttempt
        // reads the attempt actually committed here — not the pre-create
        // value session-sandbox.ts's onAttemptStart hook persisted, which the
        // advance-on-persistent-name_taken branch above may have superseded.
        ...(dedup ? { platinumCreateAttempt: committedAttempt } : {}),
      },
    };
  }

  async ensureAppRuntimeStarted(externalId: string): Promise<void> {
    // Platinum restores the template filesystem but does not run the image
    // ENTRYPOINT. appd owns daemonization, locking, and PID validation so this
    // path works in images without a shell or flock utility.
    const response = await platinumJson<PlatinumExecResponse>(`/v1/sandboxes/${externalId}/exec`, {
      method: 'POST',
      body: JSON.stringify({ cmd: ['/kortix/bin/kortix-appd', '--daemon'], timeout_ms: 15_000 }),
    });
    const result = response.result;
    if (!result || result.exit_code !== 0) {
      const detail = result?.stderr || result?.error || response.error || 'missing exec result';
      throw new Error(
        `Platinum App bootstrap failed for ${externalId}: exit ${result?.exit_code ?? 'unknown'}: ${detail.slice(0, 500)}`,
      );
    }
  }

  async start(externalId: string, opts: SandboxStartOptions = {}): Promise<void> {
    let deadline = Date.now() + START_CONFLICT_GRACE_MS;
    const restoreDeadline = Date.now() + START_RESTORE_BUDGET_MS;
    let firstConflict: unknown = null;
    // true = the box is back on disk and gets a fresh /start. That /start
    // gets a fresh stop grace too: another waiter may win the race to it, and
    // this one must then see the box through `starting`, not fail at once.
    const restored = async () => {
      if (!(await this.waitForRestore(externalId, restoreDeadline, opts.onProgress))) return false;
      deadline = Date.now() + START_CONFLICT_GRACE_MS;
      return true;
    };

    attempt: for (;;) {
      try {
        const started = await platinumJsonResponse<PlatinumSandbox>(
          `/v1/sandboxes/${externalId}/start`,
          {
            method: 'POST',
            signal: AbortSignal.timeout(START_CALL_TIMEOUT_MS),
          },
        );
        // 202 {state:'unarchiving'}: Platinum is restoring the disk from cold
        // storage, waited its 45 s inline budget, and will NOT boot the box
        // when the restore lands — its contract is "call /start again". This
        // returned on the 202, so nothing ever sent that second /start and
        // the wake fence gave up at 90 s with start_timeout (KRTX-197; 162 of
        // 241 prod unarchives on 2026-09-25 outran the inline wait).
        const state = String(started.body?.state ?? '').toLowerCase();
        if (started.status !== 202 && !state.includes('archiv')) return;
        if (await restored()) continue;
        return;
      } catch (error) {
        // Platinum acknowledges stop before the VM always reaches `stopped`.
        // An immediate user reopen can therefore race `stopping` and receive
        // 409. Keep the provider call inside this adapter until the accepted
        // stop settles, then retry start. The control plane remains stopped and
        // unbilled until its separate provider-running confirmation succeeds.
        // The CALL gave up, not Platinum: a restore it started keeps going
        // server-side. Wait on the box's real state instead of failing the wake.
        if (error instanceof Error && error.name === 'TimeoutError' && Date.now() < restoreDeadline) {
          if (await restored()) continue;
          return;
        }
        if (platinumHttp(error).status !== 409) throw error;
        firstConflict ??= error;
      }

      for (;;) {
        const sandbox = await platinumJson<PlatinumSandbox>(`/v1/sandboxes/${externalId}`);
        const state = String(sandbox.state ?? '').toLowerCase();
        if (state === 'running') return;
        if (state === 'stopped' || state === 'archived') break;
        // Another caller's /start is restoring this box, or its archive is
        // still being written. Either outlasts the stop grace, and re-posting
        // /start meanwhile only collects 409s: wait on the box instead.
        if (state.includes('archiv')) {
          if (await restored()) continue attempt;
          return;
        }
        if (!['starting', 'stopping', 'pending'].includes(state) || Date.now() >= deadline) {
          throw firstConflict;
        }
        await Bun.sleep(START_CONFLICT_POLL_MS);
      }

      if (Date.now() >= deadline) throw firstConflict;
    }
  }

  /**
   * Wait out an archive or restore. true = the box is on disk (or back to
   * `archived`) and needs its /start now; false = it moved on without one
   * (someone else started it, or it failed) and status polling takes over.
   * Throws when `until` passes first: the box is not coming up on this call.
   * `onProgress` fires on the first in-progress read, then every
   * START_PROGRESS_INTERVAL_MS while it lasts.
   */
  private async waitForRestore(
    externalId: string,
    until: number,
    onProgress?: () => Promise<void>,
  ): Promise<boolean> {
    let reportedAt = Number.NEGATIVE_INFINITY;
    while (Date.now() < until) {
      await Bun.sleep(START_RESTORE_POLL_MS);
      const sandbox = await platinumJson<PlatinumSandbox>(`/v1/sandboxes/${externalId}`).catch(
        () => null,
      );
      const state = String(sandbox?.state ?? '').toLowerCase();
      if (state === 'stopped' || state === 'archived') return true;
      if (state && !state.includes('archiv')) return false;
      if (state && onProgress && Date.now() - reportedAt >= START_PROGRESS_INTERVAL_MS) {
        reportedAt = Date.now();
        await onProgress().catch(() => undefined);
      }
    }
    throw new Error(
      `platinum sandbox ${externalId} still restoring from archive after ${START_RESTORE_BUDGET_MS / 1000}s`,
    );
  }

  async exec(
    externalId: string,
    command: string[],
    opts: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    const response = await platinumJson<PlatinumExecResponse>(`/v1/sandboxes/${externalId}/exec`, {
      method: 'POST',
      body: JSON.stringify({ cmd: command, timeout_ms: opts.timeoutMs }),
      signal: AbortSignal.timeout(opts.timeoutMs + 30_000),
    });
    const result = response.result;
    if (!result) {
      throw new Error(`Platinum exec on ${externalId} returned no result: ${response.error ?? 'unknown'}`);
    }
    return {
      exitCode: typeof result.exit_code === 'number' ? result.exit_code : -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? result.error ?? '',
    };
  }

  async renewLifecycle(externalId: string): Promise<void> {
    // Platinum resets last_activity_at before dispatching every /exec request.
    // One bounded no-op therefore renews its native idle timer without changing
    // the guest filesystem or starting a stopped sandbox.
    const response = await platinumJson<PlatinumExecResponse>(`/v1/sandboxes/${externalId}/exec`, {
      method: 'POST',
      body: JSON.stringify({ cmd: ['true'], timeout_ms: 10_000 }),
    });
    const result = response.result;
    if (!result || result.exit_code !== 0) {
      const detail = result?.stderr || result?.error || response.error || 'missing exec result';
      throw new Error(
        `Platinum lifecycle renewal failed for ${externalId}: exit ${result?.exit_code ?? 'unknown'}: ${detail.slice(0, 500)}`,
      );
    }
  }

  /**
   * Stop AND CONFIRM. Platinum acknowledges the stop request before the VM
   * always reaches `stopped` — the same fact `start()`'s comment names for the
   * reopen race. Returning right after the ACK let the control plane mark the
   * session/sandbox row stopped (which kills the token — see
   * `account-tokens.ts`'s `isValid` check) while the VM was still up and
   * still calling `turn-stream`/`audit/events`/`services/runtime-assets/manifest` with
   * that now-dead token. PROD 76h window: 404,982 `401 Session token is not
   * active` rejections across 95 projects, one box for a full 12h
   * (`autoStopMinutes: 720`) — exactly its own idle timeout, because nothing
   * had confirmed the stop and nothing was watching that box again.
   *
   * Poll bounded to `stopConfirmDeadlineMs()`: long enough for an ordinary
   * power-off, short enough not to serialize a reaper batch pass (stops run
   * with bounded concurrency — see `REAP_CONCURRENCY` in box-reaper.ts). A
   * timeout throws instead of returning silently, so the caller
   * (`stopExpiredBox`/`stopSession`) treats it as a real failure: it releases
   * its claim and leaves the DB row `active`, so the token stays valid and the
   * NEXT pass retries the same box — never a false "stopped" for a VM that is
   * still on.
   */
  async stop(externalId: string): Promise<void> {
    // Auto-resume off BEFORE the stop: Platinum resumed a box on a stray request
    // 1.3 s after `stop.done`, with its row already stopped and its token dead.
    await disableAutoResume(
      externalId,
      await platinumJson<PlatinumSandbox>(`/v1/sandboxes/${externalId}`).catch(() => null),
    );
    await platinumJson(`/v1/sandboxes/${externalId}/stop`, { method: 'POST' });
    const deadlineMs = stopConfirmDeadlineMs();
    const pollMs = stopConfirmPollMs();
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const sandbox = await platinumJson<PlatinumSandbox>(`/v1/sandboxes/${externalId}`).catch(
        // A box that vanished mid-poll (archived, deleted) is stopped for our
        // purposes — nothing left to confirm against.
        () => null,
      );
      const state = String(sandbox?.state ?? '').toLowerCase();
      if (!sandbox || state === 'stopped' || state.includes('archiv') || state === 'failed') {
        await disableAutoResume(externalId, sandbox);
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Platinum stop for ${externalId} did not reach stopped within ${deadlineMs}ms (last state: ${state || 'unknown'})`,
        );
      }
      await Bun.sleep(pollMs);
    }
  }

  /**
   * List THIS environment's running boxes, for the orphan-box reaper.
   *
   * Platinum had no implementation until Monitors needed one: every other
   * workload is ephemeral and idle-stops natively, so nothing persistent ever
   * accumulated here. A monitor box is `type: 'persistent'` and never
   * idle-stops, which makes the orphan reaper the ONLY thing that can ever
   * clean one up after its DB row is gone.
   *
   * Scoped to this control plane by the create-time metadata marker — the org
   * is shared across prod/dev/local, and an unscoped sweep would stop other
   * environments' boxes. A row without the marker is skipped, never reaped.
   */
  async listManagedRunningSandboxes(): Promise<
    Array<{ externalId: string; createdAt: Date | null }>
  > {
    const owner = await sandboxOwnershipMarker();
    const out: Array<{ externalId: string; createdAt: Date | null }> = [];
    const limit = 100;
    // Bounded page count as well as page size: a paginator that never reports
    // `has_more: false` must not spin this sweep forever.
    for (let offset = 0, page = 0; page < 50; offset += limit, page++) {
      const body = await platinumJson<PlatinumSandboxPage>(
        `/v1/sandboxes?paginated=true&limit=${limit}&offset=${offset}`,
      );
      const rows = body.rows ?? [];
      for (const sandbox of rows) {
        if (!sandbox.id) continue;
        const metadata = sandbox.metadata ?? {};
        if (metadata['kortix.managed'] !== owner) continue;
        if (String(metadata['kortix.env'] ?? '') !== config.INTERNAL_KORTIX_ENV) continue;
        // An unset local instance must not claim an explicitly scoped box.
        if (!providerBoxBelongsToThisInstance(metadata['kortix.instance'])) continue;
        if (String(sandbox.state ?? '').toLowerCase() !== 'running') continue;
        const rawCreatedAt = sandbox.created_at ?? sandbox.createdAt ?? null;
        const createdAt = rawCreatedAt ? new Date(rawCreatedAt) : null;
        out.push({
          externalId: sandbox.id,
          // An unparseable timestamp reads as unknown, and the reaper skips a
          // box whose age it cannot establish.
          createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
        });
      }
      if (!body.has_more || rows.length === 0) break;
    }
    return out;
  }

  async remove(externalId: string): Promise<void> {
    // No credential replicas to erase first: Kortix stopped registering secrets
    // at the Platinum edge when one mechanism took over every provider.
    // The value is
    // substituted server-side per request and never leaves the API.
    await platinumJson(`/v1/sandboxes/${externalId}`, { method: 'DELETE' });
  }

  async getStatus(externalId: string): Promise<SandboxStatus> {
    try {
      const sandbox = await platinumJson<PlatinumSandbox>(`/v1/sandboxes/${externalId}`);
      const state = String(sandbox.state ?? '').toLowerCase();
      if (state === 'running') return 'running';
      // A stop ACK is not power-off. Keep the token and compute row alive
      // until the provider confirms a terminal state.
      if (state === 'stopped' || state.includes('archiv')) return 'stopped';
      if (state === 'deleted' || state === 'failed-start' || state === 'lost') return 'removed';
      // Terminal, not transitional. Same audit as Daytona's `error`: a dead box
      // reported as `unknown` is a box `decideReconcile` never acts on, and
      // compute billing then accrues wall-clock against it indefinitely.
      if (state === 'error' || state === 'failed') return 'terminal';
      return 'unknown'; // provisioning / starting / resuming / migrating — transitional
    } catch (err) {
      if (isProviderNotFound(err)) return 'removed';
      return 'unknown';
    }
  }

  async recoverInPlace(externalId: string): Promise<InPlaceRecoveryStatus> {
    let sandbox: PlatinumSandbox;
    try {
      sandbox = await platinumJson<PlatinumSandbox>(`/v1/sandboxes/${externalId}`);
    } catch (err) {
      if (!isProviderNotFound(err)) return 'recovering';
      // A 404 is NOT proof the data is gone — it is also what a TOMBSTONED
      // sandbox returns. Platinum's reconciler deletes a box whose disk it has
      // already backed up to S3 (incident 2026-08-12, one Platinum sandbox:
      // deleted with a completed 4.87 GB backup), and from then on the GET 404s.
      //
      // Returning 'unavailable' here made the restore branch below DEAD CODE:
      // it handles `state ∈ {failed-start, lost, deleted}` + a completed backup,
      // but a `deleted` sandbox can never reach it, because this catch fires
      // first. So the one path written to recover this exact case never ran.
      //
      // Ask for the restore directly instead. Platinum currently refuses a
      // tombstoned row (`sbx.deletedAt` guard on the endpoint), so this is
      // expected to fail TODAY — it succeeds the moment that guard is relaxed,
      // and until then it costs one request and still answers 'unavailable'.
      return (await this.tryRestoreFromBackup(externalId)) ? 'recovering' : 'unavailable';
    }

    const state = String(sandbox.state ?? '').toLowerCase();
    if (state === 'running') return 'running';

    if (state === 'stopped' || state === 'stopping' || state.includes('archiv')) {
      await this.start(externalId);
      return 'recovering';
    }

    // A terminal VM state is not proof of data loss. Platinum continuously
    // backs up data-bearing disks and can restore that backup onto a healthy
    // host while retaining the exact sandbox id.
    if (
      ['failed-start', 'lost', 'deleted'].includes(state) &&
      String(sandbox.backupState ?? sandbox.backup_state ?? '').toLowerCase() === 'completed'
    ) {
      return (await this.tryRestoreFromBackup(externalId)) ? 'recovering' : 'unavailable';
    }

    // failed-start is a start that failed, not a box that is gone. Platinum
    // keeps the disk of a box that ever booted and takes /start again from it
    // (re-restoring the archive when there is one). 2026-09-25: a Platinum
    // reconciler race failed 17 prod starts mid-boot with every disk intact on
    // its host; this answered 'unavailable' for each and the sessions were
    // reported lost. A refused /start throws, which callers read as unavailable.
    if (state === 'failed-start' && (sandbox.startedAt ?? sandbox.started_at)) {
      await this.start(externalId);
      return 'recovering';
    }

    if (['failed-start', 'lost', 'deleted'].includes(state)) return 'unavailable';
    return 'recovering';
  }

  /**
   * Ask Platinum to re-spawn this sandbox from its S3 backup, keeping the id.
   *
   * Returns false rather than throwing: every caller is deciding "is this
   * runtime recoverable", and a refusal is an answer, not a fault. Losing that
   * distinction is what let a recoverable box be reported as permanently gone.
   */
  private async tryRestoreFromBackup(externalId: string): Promise<boolean> {
    try {
      await platinumJson(`/v1/sandboxes/${externalId}/restore-from-backup`, {
        method: 'POST',
        signal: AbortSignal.timeout(120_000),
      });
      return true;
    } catch (err) {
      console.warn(
        `[platinum] restore-from-backup refused for ${externalId}:`,
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  async resolveIngress(
    externalId: string,
    request: SandboxIngressRequest,
  ): Promise<ResolvedSandboxIngress> {
    const route = this.routeIngress(request);
    const effectivePort = route.effectivePort;
    // Expose the requested port through Platinum's edge → https://<port>-<id>.sbx…
    // PRIVATE: the edge refuses a request without the HMAC token, so the edge
    // hostname alone grants nothing. The token rides in a header on every
    // proxied request. Re-exposing is idempotent and turns a port an older
    // build exposed publicly back into a private one.
    const exposed = await platinumJson<PlatinumExposedPort>(`/v1/sandboxes/${externalId}/expose`, {
      method: 'POST',
      body: JSON.stringify({
        port: effectivePort,
        public: false,
        ttl_seconds: PREVIEW_TOKEN_TTL_SECONDS,
      }),
    });
    const { url, token } = privateEdgeIngress({ ...exposed, port: exposed.port ?? effectivePort });
    this.hardenLegacyPublicExposures(externalId);
    return {
      url,
      headers: { [PLATINUM_PREVIEW_TOKEN_HEADER]: token },
      queryToken: { name: 't', value: token },
      effectivePort,
      websocket: route.websocket,
    };
  }

  /**
   * Convert every port an older build exposed PUBLICLY on this sandbox to a
   * private exposure. Runs once per sandbox per process, detached from the
   * request: a public exposure outlives the request that created it, so a port
   * nobody opens again would otherwise stay reachable without Kortix
   * authorization until the sandbox is deleted.
   */
  private hardenLegacyPublicExposures(externalId: string): void {
    if (hardenedExposureSandboxes.has(externalId)) return;
    if (hardenedExposureSandboxes.size >= HARDENED_EXPOSURE_CACHE_MAX) {
      hardenedExposureSandboxes.clear();
    }
    hardenedExposureSandboxes.add(externalId);
    void (async () => {
      const sandbox = await platinumJson<PlatinumSandbox>(`/v1/sandboxes/${externalId}`);
      for (const port of publicExposedPorts(sandbox)) {
        await platinumJson<PlatinumExposedPort>(`/v1/sandboxes/${externalId}/expose`, {
          method: 'POST',
          body: JSON.stringify({ port, public: false, ttl_seconds: PREVIEW_TOKEN_TTL_SECONDS }),
        });
        console.log(`[platinum] converted public exposure ${externalId}:${port} to private`);
      }
    })().catch((err) => {
      // Retry on a later request: the next resolveIngress re-runs the pass.
      hardenedExposureSandboxes.delete(externalId);
      console.warn(
        `[platinum] public-exposure conversion failed for ${externalId}:`,
        err instanceof Error ? err.message : err,
      );
    });
  }

  routeIngress(request: SandboxIngressRequest) {
    const ptyWebsocket =
      request.transport === 'websocket' && classifyPtyWebSocketPath(request.path) !== null;
    return {
      // Either half of the opencode pair rewrites to the agent bridge —
      // Platinum cannot expose opencode's port directly. After a verified
      // reload the live half may be the standby, and matching only 4096 would
      // send it upstream unrewritten (see services/sessions/opencode-ports).
      effectivePort: isOpencodePort(request.port) || ptyWebsocket ? AGENT_PORT : request.port,
      websocket: ptyWebsocket
        ? {
            userContextQueryParam: '__kortix_user_context',
            queryDefaults: { cursor: '0' },
          }
        : undefined,
    };
  }

  async resolveEndpoint(externalId: string): Promise<ResolvedEndpoint> {
    // Expose the agent port through Platinum's edge, privately: the preview
    // token travels in the header resolveIngress returns, and the daemon also
    // checks the KORTIX serviceKey bearer below (the same two layers as
    // Daytona's preview token + serviceKey).
    // POST /:id/expose takes a SINGLE {port,public} and returns a single
    // {url,port,...} — the array {expose:[...]} shape is only valid on the
    // create route's inline expose. Sending the array here 400s.
    const ingress = await this.resolveIngress(externalId, { port: AGENT_PORT, transport: 'http' });
    const headers: Record<string, string> = {
      ...ingress.headers,
      'Content-Type': 'application/json',
    };
    try {
      const serviceKey = await serviceKeyForExternalId(externalId);
      if (serviceKey) headers.Authorization = `Bearer ${serviceKey}`;
    } catch (err) {
      console.warn(`[PLATINUM] Failed to look up service key for ${externalId}:`, err);
    }

    return { url: ingress.url, headers };
  }

  async ensureRunning(externalId: string): Promise<void> {
    const status = await this.getStatus(externalId);
    if (status === 'running') return;
    // Only a stopped sandbox can be started; poking a transitional one would
    // 409. Anything else we leave to settle / to the reconciler.
    if (status === 'stopped') {
      console.log(`[PLATINUM] Sandbox ${externalId} is stopped, waking up...`);
      await this.start(externalId);
    }
  }
}
