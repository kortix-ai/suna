'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

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

/** A failed lazy chunk is the one involuntary reload cause we can see COMING. */
export function noteChunkLoadFailure(message: string): void {
  try {
    sessionStorage.setItem(CHUNK_ERROR_KEY, JSON.stringify({ message, at: Date.now() }));
  } catch {
    /* storage unavailable — the label is a nice-to-have, never a requirement */
  }
}

export interface ReloadForensics {
  /** Chrome dropped the tab (memory pressure) and restored it on return. */
  discarded: boolean;
  /** 'reload' | 'navigate' | 'back_forward' | 'prerender' | null */
  navigationType: string | null;
  /** A chunk load failed in the previous life of this tab, within 30s. */
  recentChunkError: string | null;
}

export function readReloadForensics(now = Date.now()): ReloadForensics {
  let discarded = false;
  let navigationType: string | null = null;
  let recentChunkError: string | null = null;

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

  return { discarded, navigationType, recentChunkError };
}

/** True when the load looks involuntary — worth reporting, unlike an ordinary
 *  navigation or a reload the user pressed themselves (which we cannot tell
 *  apart from an automatic one, so a bare 'reload' alone is NOT enough). */
export function isInvoluntaryLoad(f: ReloadForensics): boolean {
  return f.discarded || f.recentChunkError !== null;
}

/**
 * Label this page load, and watch for the chunk failure that would explain the
 * NEXT one. Mount once per session page.
 *
 * Reports only an involuntary load (`isInvoluntaryLoad`), so an ordinary
 * navigation — or a reload someone pressed — stays silent. What lands in Sentry
 * is the distinction the screen recording could not make: discarded tab vs
 * chunk-404-after-deploy.
 */
export function useReloadForensics(sessionId: string | null | undefined): void {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      const message = event?.message ?? '';
      if (/loading chunk|chunkloaderror|failed to fetch dynamically imported module/i.test(message)) {
        noteChunkLoadFailure(message);
      }
    };
    window.addEventListener('error', onError);

    const forensics = readReloadForensics();
    if (isInvoluntaryLoad(forensics)) {
      console.warn('[session] involuntary page load', { sessionId, ...forensics });
      Sentry.captureMessage('session page reloaded involuntarily', {
        level: 'warning',
        extra: { sessionId, ...forensics },
      });
    }

    return () => window.removeEventListener('error', onError);
  }, [sessionId]);
}
