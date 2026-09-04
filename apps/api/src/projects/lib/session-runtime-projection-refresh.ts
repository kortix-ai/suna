/**
 * Filling the runtime-projection store — the v1 write path.
 *
 * ─── PUSH IS THE DESIGN; PULL-THROUGH IS WHAT SHIPS FIRST ──────────────────
 * DESIGN-V §6.4 has the daemon PUSH its projection to
 * `POST /v1/platform/runtime-projection` on boot and on change. That endpoint
 * exists (`platform/routes/runtime-projection.ts`) and is the eventual write
 * path. What does not exist yet is the daemon-side caller — WS-Z1 shipped the
 * projection and the route that serves it, deliberately leaving the push as
 * "a latency optimisation on top, not a prerequisite" (DONE-Z1 §7).
 *
 * So v1 fills the store by PULLING: whenever the API is already talking to a
 * box (a stream attaches) or already answering about one (a bundle read finds
 * the row missing or stale), it reads `GET /kortix/opencode/state` in the
 * BACKGROUND and stores the result. The document is etag-gated at the daemon,
 * so a repeat costs a 304 and no body.
 *
 * ─── THE INVARIANT THIS DOES NOT BREAK ─────────────────────────────────────
 * `open-bundle` promises that its RESPONSE never waits on a sandbox. That
 * promise is intact: every call here is fire-and-forget, is never awaited by a
 * request handler, and is skipped entirely unless the session's sandbox row
 * ALREADY says `active`. Nothing here can wake a box, extend its deadline, or
 * make a stopped session slower to open — the three ways a "harmless"
 * background read turns into an incident.
 */

import { eq } from 'drizzle-orm';
import { sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { fetchRuntimeState } from './session-runtime-transport';
import {
  saveRuntimeProjection,
  type RuntimeProjectionSource,
} from './session-runtime-projection';

/** Shortest gap between two background refreshes of the same session. */
export const PROJECTION_REFRESH_MIN_INTERVAL_MS = 30_000;

/** Last refresh attempt per session, and the in-flight promise if any. */
const lastAttemptAt = new Map<string, number>();
const inFlight = new Map<string, Promise<RefreshOutcome>>();
/** Last etag seen per session, so a repeat read costs a 304 with no body. */
const etags = new Map<string, string>();

export type RefreshOutcome =
  | { refreshed: true; etag: string | null; stored: 'stored' | 'ignored' }
  | { refreshed: false; reason: string };

export interface RefreshTarget {
  sessionId: string;
  projectId: string;
  accountId: string;
  /** Signs the daemon's `X-Kortix-User-Context`. */
  userId: string;
}

/**
 * Refresh a session's projection from its box, if that is safe and useful.
 *
 * Returns a promise so the stream can await it when it WANTS the answer; the
 * bundle deliberately does not.
 */
export async function refreshRuntimeProjection(
  target: RefreshTarget,
  options: { force?: boolean; source?: RuntimeProjectionSource } = {},
): Promise<RefreshOutcome> {
  const existing = inFlight.get(target.sessionId);
  if (existing) return existing;

  const last = lastAttemptAt.get(target.sessionId) ?? 0;
  if (!options.force && Date.now() - last < PROJECTION_REFRESH_MIN_INTERVAL_MS) {
    return { refreshed: false, reason: 'throttled' };
  }
  lastAttemptAt.set(target.sessionId, Date.now());

  const run = (async (): Promise<RefreshOutcome> => {
    // The box must ALREADY be up. This read is the gate that keeps a background
    // refresh from ever touching a provider: no row, or any status other than
    // `active`, and we do not go near the sandbox.
    const [sandbox] = await db
      .select({ externalId: sessionSandboxes.externalId, status: sessionSandboxes.status })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sessionId, target.sessionId))
      .limit(1);
    if (!sandbox?.externalId) return { refreshed: false, reason: 'no_sandbox' };
    if (sandbox.status !== 'active') {
      return { refreshed: false, reason: `sandbox_${sandbox.status}` };
    }

    const result = await fetchRuntimeState(
      { externalId: sandbox.externalId, userId: target.userId },
      { ifNoneMatch: etags.get(target.sessionId) ?? null },
    );
    if (!result.ok) return { refreshed: false, reason: result.reason };
    if (result.status === 304) {
      return { refreshed: false, reason: 'not_modified' };
    }

    if (result.etag) etags.set(target.sessionId, result.etag);
    const stored = await saveRuntimeProjection({
      sessionId: target.sessionId,
      projectId: target.projectId,
      accountId: target.accountId,
      externalId: sandbox.externalId,
      // The daemon's ETag when it gave one; the document's own `built_at` +
      // epoch otherwise. Never a hash computed here — two different hashes of
      // the same document is how an etag stops meaning anything.
      projectionEtag: result.etag ?? fallbackEtag(result.doc),
      projection: result.doc,
      capturedAt: builtAt(result.doc),
      source: options.source ?? 'api_pull',
    });
    return { refreshed: true, etag: result.etag, stored };
  })();

  inFlight.set(target.sessionId, run);
  try {
    return await run;
  } catch (error) {
    return {
      refreshed: false,
      reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    };
  } finally {
    inFlight.delete(target.sessionId);
  }
}

/**
 * Schedule a refresh without waiting for it, and without letting a failure
 * reach the caller's error path. This is what a request handler calls.
 */
export function scheduleRuntimeProjectionRefresh(target: RefreshTarget): void {
  void refreshRuntimeProjection(target).catch(() => {});
}

/** `built_at` is the daemon's own capture clock; fall back to ours if absent. */
function builtAt(doc: Record<string, unknown>): Date {
  const raw = doc.built_at;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  return new Date();
}

/** A stable identity for a document the daemon served without an ETag. */
function fallbackEtag(doc: Record<string, unknown>): string {
  const epoch = typeof doc.epoch === 'string' ? doc.epoch : 'no-epoch';
  const seq = typeof doc.seq === 'number' ? doc.seq : -1;
  const built = typeof doc.built_at === 'string' ? doc.built_at : '';
  return `daemon:${epoch}:${seq}:${built}`;
}

/** Test-only: forget throttles, etags and in-flight refreshes. */
export function __resetRuntimeProjectionRefreshForTests(): void {
  lastAttemptAt.clear();
  inFlight.clear();
  etags.clear();
}
