'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

/**
 * Why did this session page load again?
 *
 * A user reported sessions "randomly disconnecting" on long threads, and a
 * screen recording (2026-08-23) showed the page reload ITSELF mid-turn — no
 * click, cursor motionless — then re-render into the composer's waking state.
 * Nothing in the app calls `location.reload()` on its own, so the reload came
 * from outside our code, and after the fact there is no way to tell which
 * outside: Chrome discarding a heavy tab under memory pressure, a chunk that
 * 404'd after a deploy (App Router recovers with a hard navigation), or a
 * renderer crash. Those need different fixes, and guessing between them is how
 * this stays open.
 *
 * So record the one moment that can distinguish them — the load right after —
 * and label it. Read-only, best-effort, and silent unless something actually
 * looks involuntary.
 */

const CHUNK_ERROR_KEY = 'kortix.lastChunkError';
const HEAP_SAMPLE_KEY = 'kortix.lastHeapSample';

/**
 * Heap size above which a bare reload stops looking ordinary.
 *
 * Chrome kills a renderer that runs out of memory and reloads the tab, and that
 * load is indistinguishable from cmd+R in every field the platform exposes —
 * `wasDiscarded` is false, the navigation type is 'reload', no chunk failed. So
 * the previous life has to leave the evidence behind itself. A session tab
 * sitting above this before it vanished is not a person pressing reload.
 *
 * Chrome's per-renderer budget on a 64-bit desktop is ~2-4GB; 1.5GB is high
 * enough that an ordinary thread never reaches it and low enough to catch the
 * approach to a kill.
 */
export const HEAP_PRESSURE_BYTES = 1_500_000_000;

/** A failed lazy chunk is the one involuntary reload cause we can see COMING. */
export function noteChunkLoadFailure(message: string): void {
  try {
    sessionStorage.setItem(CHUNK_ERROR_KEY, JSON.stringify({ message, at: Date.now() }));
  } catch {
    /* storage unavailable — the label is a nice-to-have, never a requirement */
  }
}

/** Record what this tab is holding, so the NEXT load can say whether it died
 *  under memory pressure. Best-effort: `performance.memory` is Chromium-only
 *  and absent in a cross-origin-isolated context. */
export function noteHeapSample(now = Date.now()): void {
  try {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
    const used = memory?.usedJSHeapSize;
    if (typeof used !== 'number') return;
    sessionStorage.setItem(HEAP_SAMPLE_KEY, JSON.stringify({ used, at: now }));
  } catch {
    /* storage or the API is unavailable — the label is a nice-to-have */
  }
}

export interface ReloadForensics {
  /** Chrome dropped the tab (memory pressure) and restored it on return. */
  discarded: boolean;
  /** 'reload' | 'navigate' | 'back_forward' | 'prerender' | null */
  navigationType: string | null;
  /** A chunk load failed in the previous life of this tab, within 30s. */
  recentChunkError: string | null;
  /** Bytes this tab was holding just before it went away, when the previous
   *  life recorded a sample within the last 2 minutes. */
  heapBeforeReload: number | null;
}

export function readReloadForensics(now = Date.now()): ReloadForensics {
  let discarded = false;
  let navigationType: string | null = null;
  let recentChunkError: string | null = null;
  let heapBeforeReload: number | null = null;

  try {
    discarded = (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true;
  } catch {
    /* older engines */
  }
  try {
    const [nav] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    navigationType = nav?.type ?? null;
  } catch {
    /* no navigation timing */
  }
  try {
    const raw = sessionStorage.getItem(CHUNK_ERROR_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { message?: string; at?: number };
      // Only the previous life counts. An hour-old entry says nothing about
      // THIS load, and a stale label is worse than none.
      if (parsed?.at && now - parsed.at < 30_000 && parsed.message) {
        recentChunkError = parsed.message;
      }
      sessionStorage.removeItem(CHUNK_ERROR_KEY);
    }
  } catch {
    /* storage unavailable */
  }

  try {
    const raw = sessionStorage.getItem(HEAP_SAMPLE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { used?: number; at?: number };
      if (parsed?.at && now - parsed.at < 120_000 && typeof parsed.used === 'number') {
        heapBeforeReload = parsed.used;
      }
      sessionStorage.removeItem(HEAP_SAMPLE_KEY);
    }
  } catch {
    /* storage unavailable */
  }

  return { discarded, navigationType, recentChunkError, heapBeforeReload };
}

/**
 * What ended the previous life of this tab.
 *
 * - `discarded`    — the browser itself unloaded a backgrounded tab and reloaded
 *                    it on return. Expected, self-healing, and not something the
 *                    app can prevent.
 * - `chunk-error`  — a lazy chunk failed in the previous life, then the page
 *                    loaded again. A deploy left this tab on stale chunks.
 * - `renderer-oom` — a plain reload with a heap above `HEAP_PRESSURE_BYTES`:
 *                    the renderer was killed for memory. The one cause with no
 *                    other fingerprint.
 */
export type ReloadCause = 'discarded' | 'chunk-error' | 'renderer-oom';

/** Name the involuntary load, or `null` when the load looks ordinary. */
export function classifyReloadCause(f: ReloadForensics): ReloadCause | null {
  // A chunk failure is the most specific signal — report it even if the tab was
  // also discarded, because it is the one we can act on (a stale deployment).
  if (f.recentChunkError !== null) return 'chunk-error';
  if (f.discarded) return 'discarded';
  // The renderer-OOM signature: a plain reload, no chunk error, nothing
  // discarded — but the tab was holding more than a person's session should
  // just before it vanished. Without this the one hypothesis with no other
  // fingerprint stays invisible.
  if (f.navigationType === 'reload' && (f.heapBeforeReload ?? 0) >= HEAP_PRESSURE_BYTES) {
    return 'renderer-oom';
  }
  return null;
}

/** True when the load looks involuntary — worth reporting, unlike an ordinary
 *  navigation or a reload the user pressed themselves (which we cannot tell
 *  apart from an automatic one, so a bare 'reload' alone is NOT enough). Boolean
 *  summary of `classifyReloadCause`. */
export function isInvoluntaryLoad(f: ReloadForensics): boolean {
  return classifyReloadCause(f) !== null;
}

/**
 * True when the cause deserves a standalone Sentry event.
 *
 * A `discarded` tab is routine background reclaim: Chrome unloads a backgrounded
 * tab and reloads it when the user comes back. It is expected browser behavior,
 * not an app defect — the page reloads from the URL and the session reconnects
 * from its durable state. It must not page. The two causes we CAN act on keep
 * reporting: a failed lazy chunk is a deploy that left a stale tab behind, and a
 * renderer killed under heap pressure is the silent one with no other
 * fingerprint.
 */
export function shouldReportReloadCause(cause: ReloadCause | null): boolean {
  return cause === 'chunk-error' || cause === 'renderer-oom';
}

/**
 * Label this page load, and watch for the chunk failure that would explain the
 * NEXT one. Mount once per session page.
 *
 * Classifies the load once (`classifyReloadCause`); an ordinary navigation — or a
 * reload someone pressed — has no cause and stays silent. Every involuntary load
 * is logged locally. A Sentry event fires only for an actionable cause
 * (`shouldReportReloadCause`): a chunk-404-after-deploy or a renderer killed
 * under heap pressure. A browser tab discard, the overwhelming majority, leaves a
 * breadcrumb instead so it still explains a later error without paging on its
 * own.
 */
export function useReloadForensics(sessionId: string | null | undefined): void {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      const message = event?.message ?? '';
      if (
        /loading chunk|chunkloaderror|failed to fetch dynamically imported module/i.test(message)
      ) {
        noteChunkLoadFailure(message);
      }
    };
    window.addEventListener('error', onError);

    // Sample now and on an interval, so whatever ends this tab leaves a number
    // behind. 30s is far below the 2-minute freshness window the reader applies.
    noteHeapSample();
    const heapTimer = window.setInterval(() => noteHeapSample(), 30_000);

    const forensics = readReloadForensics();
    const cause = classifyReloadCause(forensics);
    if (cause !== null) {
      console.warn('[session] involuntary page load', { sessionId, cause, ...forensics });
    }
    if (shouldReportReloadCause(cause)) {
      Sentry.captureMessage('session page reloaded involuntarily', {
        level: 'warning',
        extra: { sessionId, cause, ...forensics },
      });
    } else if (cause === 'discarded') {
      // Expected browser behavior, not an app fault: keep the cause as a
      // breadcrumb so it still attaches to any later real error, but never page
      // on the discard itself. No `message` field — a `message:` literal reads as
      // UI copy to the i18n audit, and this is developer-facing telemetry; the
      // category and `data.cause` carry the meaning.
      Sentry.addBreadcrumb({
        category: 'session.reload',
        level: 'info',
        data: { sessionId, cause, ...forensics },
      });
    }

    return () => {
      window.clearInterval(heapTimer);
      window.removeEventListener('error', onError);
    };
  }, [sessionId]);
}
