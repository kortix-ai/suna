/**
 * Per-request stage accounting for the `Server-Timing` response header.
 *
 * ─── Why (2026-09-23) ───────────────────────────────────────────────────────
 * `Server-Timing: api;dur=…` told us a staging `/v1/accounts` took 1–6 s but
 * not where: token verification, IAM, database round trips, git, or an HTTP
 * hop. Every fix proposed from that number was a guess. This module lets the
 * hot layers record their time so one response header answers the question:
 *
 *   Server-Timing: total;dur=412, auth;dur=38, gotrue;dur=35, iam;dur=9,
 *                  db;dur=160;desc="n=11", git;dur=0, http;dur=0, api;dur=412
 *
 * Stages may overlap (IAM time includes the DB queries it issues; auth includes
 * the GoTrue call). Each stage reports its WALL time — the union of its
 * in-flight intervals — so 5 parallel 20 ms queries report `db;dur=20`, not 100.
 * `desc="n=…"` carries the operation count, which is the number that predicts
 * latency on a high-RTT database link (staging API ↔ DB is ~140 ms apart).
 *
 * Cost: one `performance.now()` pair per recorded operation and a small object
 * on the request context. Always on. Outside a request scope every call is a
 * no-op, so background work never has to guard.
 */

import { getRequestContext } from './request-context';

export type TimingStage = 'auth' | 'gotrue' | 'iam' | 'db' | 'git' | 'http';

/** Header emission order. Stages with zero operations are omitted. */
export const TIMING_STAGES: readonly TimingStage[] = ['auth', 'gotrue', 'iam', 'db', 'git', 'http'];

interface StageStat {
  count: number;
  /** Union of in-flight intervals, closed intervals only. */
  wallMs: number;
  inflight: number;
  openedAt: number;
}

type StageStore = Partial<Record<TimingStage, StageStat>>;

const STAGES_KEY = Symbol.for('kortix.server-timing-stages');

function stageStore(create: boolean): StageStore | null {
  const ctx = getRequestContext() as ({ [STAGES_KEY]?: StageStore } & object) | undefined;
  if (!ctx) return null;
  let store = ctx[STAGES_KEY];
  if (!store && create) {
    store = {};
    ctx[STAGES_KEY] = store;
  }
  return store ?? null;
}

const NOOP = () => {};

/**
 * Open one operation of `stage` and return the function that closes it. The
 * closer is idempotent. The store is captured at open time, so closing from a
 * callback that lost the AsyncLocalStorage scope still lands on the right
 * request.
 */
export function beginStage(stage: TimingStage): () => void {
  const store = stageStore(true);
  if (!store) return NOOP;
  const stat = (store[stage] ??= { count: 0, wallMs: 0, inflight: 0, openedAt: 0 });
  stat.count += 1;
  if (stat.inflight === 0) stat.openedAt = performance.now();
  stat.inflight += 1;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    stat.inflight -= 1;
    if (stat.inflight === 0) stat.wallMs += performance.now() - stat.openedAt;
  };
}

/** Time `fn` as one operation of `stage`. Records on throw too. */
export async function timeStage<T>(stage: TimingStage, fn: () => Promise<T>): Promise<T> {
  const end = beginStage(stage);
  try {
    return await fn();
  } finally {
    end();
  }
}

export interface StageSnapshot {
  count: number;
  wallMs: number;
}

/**
 * Read this request's stages. An operation still in flight (a fire-and-forget
 * write that outlives the response) counts up to `now`.
 */
export function stageSnapshot(now = performance.now()): Partial<Record<TimingStage, StageSnapshot>> {
  const store = stageStore(false);
  if (!store) return {};
  const out: Partial<Record<TimingStage, StageSnapshot>> = {};
  for (const stage of TIMING_STAGES) {
    const stat = store[stage];
    if (!stat || stat.count === 0) continue;
    const open = stat.inflight > 0 ? now - stat.openedAt : 0;
    out[stage] = { count: stat.count, wallMs: stat.wallMs + open };
  }
  return out;
}

/** Render the stage entries of a `Server-Timing` header (no leading comma). */
export function formatStageEntries(stages: Partial<Record<TimingStage, StageSnapshot>>): string[] {
  const entries: string[] = [];
  for (const stage of TIMING_STAGES) {
    const stat = stages[stage];
    if (!stat) continue;
    entries.push(`${stage};dur=${Math.round(stat.wallMs)};desc="n=${stat.count}"`);
  }
  return entries;
}

// ─── Turn-path stage marks (ProvisionTimeline) ─────────────────────────────
//
// The turn-latency spec (PR #7840) §5: `apps/api/src/platform/services/
// provision-timeline.ts` records one mark per stage of the send path
// (`load-sandbox`, `agent-switch`, `config-converge`, `model-catalog-converge`,
// `ingress`, `env-sync`, `wire-id-read`, `turn-begin`, `upstream`,
// `turn-accept` — see `sandbox-proxy/routes/preview.ts`). Unlike the stages
// above, these are a finished, ORDERED SEQUENCE of milestones from one call,
// not an accumulating count of same-shaped operations — there is nothing to
// "begin" and "end", so `recordTurnStageMarks` takes the whole list at once.
//
// Namespaced `turnstage-<label>` (not a bare label) so a benchmark reading
// this header can recognize every mark that belongs to the turn breakdown by
// PREFIX alone, without hardcoding today's stage names — three concurrent
// branches are actively adding and renaming `ptl.mark(...)` calls, and a new
// one must show up on the header automatically, not require an allowlist edit
// here to stop being silently dropped.

const TURN_MARKS_KEY = Symbol.for('kortix.server-timing-turn-marks');
export const TURN_STAGE_PREFIX = 'turnstage-';

export interface TurnStageMark {
  label: string;
  deltaMs: number;
}

interface TurnMarksStore {
  [TURN_MARKS_KEY]?: TurnStageMark[];
}

/**
 * Record this request's turn-path stage marks, in order. No-op outside a
 * request scope (mirrors `beginStage` above), so a caller never has to guard.
 * Replaces any marks recorded earlier in the same request — a retried proxy
 * attempt calls this again with the latest ProvisionTimeline summary, and the
 * header should reflect the attempt that actually returned, not the sum.
 */
export function recordTurnStageMarks(marks: TurnStageMark[]): void {
  const ctx = getRequestContext() as TurnMarksStore | undefined;
  if (!ctx || !marks) return;
  ctx[TURN_MARKS_KEY] = marks;
}

/** Render this request's turn stage marks as `Server-Timing` entries, in order. */
export function formatTurnStageEntries(): string[] {
  const ctx = getRequestContext() as TurnMarksStore | undefined;
  const marks = ctx?.[TURN_MARKS_KEY] ?? [];
  return marks.map((m) => `${TURN_STAGE_PREFIX}${m.label};dur=${Math.round(m.deltaMs)}`);
}

// ─── Outbound HTTP ──────────────────────────────────────────────────────────

const FETCH_WRAPPED = Symbol.for('kortix.server-timing-fetch');

/**
 * Classify an outbound request. GoTrue (`<SUPABASE_URL>/auth/v1/...`) is its
 * own stage because it sits on the auth path of every request that cannot be
 * verified locally; everything else is `http` (sandbox daemon, sandbox
 * providers, GitHub API, Stripe, …).
 */
export function classifyOutbound(url: string, supabaseUrl: string | undefined): TimingStage {
  if (supabaseUrl && url.startsWith(`${supabaseUrl.replace(/\/+$/, '')}/auth/`)) return 'gotrue';
  return 'http';
}

function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && 'url' in input) return String((input as { url: unknown }).url);
  return '';
}

/**
 * Wrap `globalThis.fetch` once so every outbound call made inside a request is
 * attributed. Time is measured to the response HEADERS (when `fetch` resolves),
 * so a long-lived stream counts its time-to-first-byte, not its lifetime.
 * Idempotent; properties on the original (`fetch.preconnect`) are preserved.
 */
export function installFetchTiming(supabaseUrl: string | undefined): void {
  const original = globalThis.fetch as typeof fetch & { [FETCH_WRAPPED]?: true };
  if (original[FETCH_WRAPPED]) return;
  const wrapped = function timedFetch(this: unknown, input: unknown, init?: unknown) {
    if (!getRequestContext()) {
      return (original as (...args: unknown[]) => Promise<Response>).call(this, input, init);
    }
    const end = beginStage(classifyOutbound(requestUrl(input), supabaseUrl));
    const pending = (original as (...args: unknown[]) => Promise<Response>).call(this, input, init);
    pending.then(end, end);
    return pending;
  } as unknown as typeof fetch & { [FETCH_WRAPPED]?: true };
  Object.assign(wrapped, original);
  wrapped[FETCH_WRAPPED] = true;
  globalThis.fetch = wrapped;
}
