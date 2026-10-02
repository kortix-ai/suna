import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authenticatedFetch, getAuthToken } from '../core/http/auth';

/** Images at or below this size auto-load; larger ones wait for a tap. */
export const IMAGE_AUTO_LOAD_LIMIT_BYTES = 8 * 1024 * 1024;

type SandboxImagePhase = 'probing' | 'load' | 'tap-to-load' | 'error';

export function decideImageLoad({
  contentLength,
  limitBytes,
}: {
  contentLength: number | null;
  limitBytes: number;
}): 'load' | 'tap-to-load' {
  if (contentLength === null) return 'load';
  return contentLength > limitBytes ? 'tap-to-load' : 'load';
}

/** Parses a `content-length` header value. Returns null when absent or invalid. */
export function parseContentLength(header: string | null): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** "8.5 MB" below 10 MB, "25 MB" from 10 MB up. */
export function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

export interface ProbeCache {
  has(url: string): boolean;
  get(url: string): number | null | undefined;
  set(url: string, contentLength: number | null): void;
  size(): number;
}

/** Bounded least-recently-used cache of HEAD probe results keyed by raw file URL. */
export function createProbeCache(limit: number): ProbeCache {
  const entries = new Map<string, number | null>();
  return {
    has: (url) => entries.has(url),
    get(url) {
      if (!entries.has(url)) return undefined;
      const value = entries.get(url) as number | null;
      entries.delete(url);
      entries.set(url, value);
      return value;
    },
    set(url, contentLength) {
      entries.delete(url);
      entries.set(url, contentLength);
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    size: () => entries.size,
  };
}

// The sandbox daemon serves HEAD through its GET handler and reads the whole
// file, so each URL is probed once per app session, not on every cell remount.
const imageProbeCache = createProbeCache(200);

/**
 * The sandbox-image load state, moved from `apps/mobile`'s hook: the SDK owns
 * the raw-file URL, the HEAD probe, the auth headers, the size gate, the probe
 * cache and the one fresh-token retry. The host binds the sandbox origin and
 * the native image events (`onError` → `handleError`, remount on `attempt`).
 *
 * The probe is a HEAD through `authenticatedFetch` — the one configured
 * token/header seam, so no host builds a second one. Behavior kept explicit
 * from the mobile hook it replaces: without a token the seam sends nothing
 * (synthetic 401) and the length reads as unknown, so the native loader still
 * runs unauthenticated; `retryOnAuthError: false` keeps a 401 probe an unknown
 * length (no probe-level retry — the native image load is the retry);
 * `timeoutMs: null` keeps the probe deadline-free, as before.
 */
export function useSandboxImage({
  sandboxUrl,
  filePath,
  enabled,
}: {
  sandboxUrl: string | undefined;
  filePath: string;
  enabled: boolean;
}) {
  const rawUrl = sandboxUrl && filePath
    ? `${sandboxUrl}/file/raw?path=${encodeURIComponent(filePath)}`
    : null;
  const [phase, setPhase] = useState<SandboxImagePhase>('probing');
  const [token, setToken] = useState<string | null>(null);
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);
  // Bumped on retry so the host's Image remounts and requests the file again.
  const [attempt, setAttempt] = useState(0);
  const retriedRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !rawUrl) return;
    const controller = new AbortController();
    let cancelled = false;
    retriedRef.current = false;
    setPhase('probing');
    (async () => {
      const authToken = await getAuthToken().catch(() => null);
      if (cancelled) return;
      let contentLength: number | null = null;
      if (imageProbeCache.has(rawUrl)) {
        contentLength = imageProbeCache.get(rawUrl) ?? null;
      } else {
        try {
          const res = await authenticatedFetch(
            rawUrl,
            { method: 'HEAD', signal: controller.signal },
            { retryOnAuthError: false, timeoutMs: null },
          );
          if (res.ok) {
            contentLength = parseContentLength(res.headers.get('content-length'));
            imageProbeCache.set(rawUrl, contentLength);
          }
        } catch {
          // Unknown length: let the native loader try; onError handles failures.
        }
      }
      if (cancelled) return;
      setToken(authToken);
      setSizeBytes(contentLength);
      setPhase(decideImageLoad({ contentLength, limitBytes: IMAGE_AUTO_LOAD_LIMIT_BYTES }));
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, rawUrl]);

  const loadAnyway = useCallback(() => setPhase('load'), []);

  // First native failure: retry once with a fresh token (the cached one may
  // have expired). Second failure: show the error fallback.
  const handleError = useCallback(() => {
    if (retriedRef.current) {
      setPhase('error');
      return;
    }
    retriedRef.current = true;
    getAuthToken()
      .catch(() => null)
      .then((fresh) => {
        if (!aliveRef.current) return;
        setToken(fresh);
        setAttempt((n) => n + 1);
      });
  }, []);

  const source = useMemo(
    () =>
      rawUrl
        ? { uri: rawUrl, headers: token ? { Authorization: `Bearer ${token}` } : undefined }
        : undefined,
    [rawUrl, token],
  );

  return { phase, source, sizeBytes, attempt, loadAnyway, handleError };
}
