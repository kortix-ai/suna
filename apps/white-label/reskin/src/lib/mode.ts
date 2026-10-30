'use client';

/**
 * Fetches (once, module-cached) whether the server is running in wrapper mode
 * — see `GET /api/mode`. `Providers` awaits this before rendering anything so
 * no data call fires against the wrong `backendUrl` (see providers.tsx).
 */
let modePromise: Promise<boolean> | null = null;

export function fetchWrapperMode(): Promise<boolean> {
  if (!modePromise) {
    modePromise = fetch('/api/mode')
      .then((res) => (res.ok ? res.json() : { wrapperMode: false }))
      .then((data) => !!data?.wrapperMode)
      .catch(() => false);
  }
  return modePromise;
}
