import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { getAuthToken } from '@/api/config';
import {
  IMAGE_AUTO_LOAD_LIMIT_BYTES,
  createProbeCache,
  decideImageLoad,
  parseContentLength,
} from '@/lib/session/image-load';

// ─── Sandbox image loading ───────────────────────────────────────────────────
// The native image loader downloads, caches, and downsamples the file, so no
// image bytes reach the JS heap. A HEAD request reads `content-length` first;
// files above IMAGE_AUTO_LOAD_LIMIT_BYTES wait for a tap.

type SandboxImagePhase = 'probing' | 'load' | 'tap-to-load' | 'error';

// The sandbox daemon serves HEAD through its GET handler and reads the whole
// file, so each URL is probed once per app session, not on every cell remount.
const imageProbeCache = createProbeCache(200);

export function useSandboxImage(filePath: string, enabled: boolean) {
  const { sandboxUrl } = useSandboxContext();
  const rawUrl = sandboxUrl && filePath
    ? `${sandboxUrl}/file/raw?path=${encodeURIComponent(filePath)}`
    : null;
  const [phase, setPhase] = useState<SandboxImagePhase>('probing');
  const [token, setToken] = useState<string | null>(null);
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);
  // Bumped on retry so the Image remounts and requests the file again.
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
          const res = await fetch(rawUrl, {
            method: 'HEAD',
            headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
            signal: controller.signal,
          });
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

  // First failure: retry once with a fresh token (the cached one may have
  // expired). Second failure: show the error fallback.
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
