'use client';

/**
 * `useStaticFilePreview` — one file, framed from the server that ships with the
 * sandbox.
 *
 * Every host that shows an HTML file needs the same four things: the proxied
 * URL of the static file server's `/open?path=…` route, an authenticated
 * session for it, a way to wait out a sandbox that is still booting, and a
 * bound on that wait. Each surface that hand-rolled them got a different subset
 * right — see `core/session/static-file-preview.ts` for why `srcDoc` is not an
 * alternative, and why the URL must not be built before a sandbox binds.
 *
 * The caller renders three states and nothing else:
 *
 *   - `checking` — spinner. The sandbox may still be starting.
 *   - `ready` + a `url` — frame it.
 *   - `unavailable` — a sentence and a `retry()`.
 *
 * `url` is `null` in every state but the last, so a caller cannot accidentally
 * frame an unauthenticated or unbound URL: there is nothing to frame.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getAuthToken } from '../core/http/auth';
import { appendPreviewToken, isSubdomainPreviewUrl } from '../core/session/preview';
import { probePreviewPort } from '../core/session/preview-probe';
import {
  STATIC_FILE_HEALTH_RETRY_MS,
  authenticatedUrlAddresses,
  shouldRetryStaticFileHealth,
  staticFilePreviewTargets,
} from '../core/session/static-file-preview';
import { useActiveSandboxProxyContext } from './runtime-actions';
import { useAuthenticatedPreviewUrl } from './use-authenticated-preview-url';

export type StaticFilePreviewStatus = 'checking' | 'ready' | 'unavailable';

export interface StaticFilePreview {
  /** The URL to frame — non-null only when `status` is `ready`. */
  url: string | null;
  status: StaticFilePreviewStatus;
  /** Start the wait over after it gave up. */
  retry: () => void;
}

export function useStaticFilePreview(
  path: string | undefined,
  options?: { enabled?: boolean },
): StaticFilePreview {
  const enabled = options?.enabled !== false;

  // The REACTIVE context, never `deriveSubdomainOpts()` read once. A sandbox
  // binds after first paint, so a value captured on mount is `sandboxId: ''`
  // for the life of the component — the exact freeze `useActiveSandboxProxyContext`
  // documents, and the reason a preview could sit at "starting" forever.
  const { subdomainOpts } = useActiveSandboxProxyContext();

  const targets = useMemo(
    () => (enabled ? staticFilePreviewTargets(path, subdomainOpts) : null),
    [enabled, path, subdomainOpts],
  );

  const authenticatedUrl = useAuthenticatedPreviewUrl(targets?.previewUrl ?? '');

  const [status, setStatus] = useState<StaticFilePreviewStatus>('checking');
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);

  useEffect(() => {
    if (!targets) {
      // Nothing to probe yet — a sandbox that has not bound is still starting,
      // which is what `checking` says.
      setStatus('checking');
      return;
    }

    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setStatus('checking');

    async function probe() {
      if (cancelled || !targets) return;
      attempts += 1;

      // A subdomain preview never receives the host-only `/v1/p` session
      // cookie, so its first request has to carry a one-shot `?token` — the
      // same bargain `useAuthenticatedPreviewUrl` strikes for the frame itself.
      // Without it this probe 401s forever, and since the frame only renders
      // once the probe passes, nothing ever authenticates the subdomain: the
      // "starting" state deadlocks.
      let url = targets.healthUrl;
      if (isSubdomainPreviewUrl(url)) {
        const token = await getAuthToken();
        if (cancelled) return;
        if (token) url = appendPreviewToken(url, token);
      }

      // `probePreviewPort` classifies rather than trusting `res.ok`: `401/403`
      // is OUR auth gate still catching up, not a dead server, so it retries
      // instead of blaming the sandbox for an expired cookie.
      const verdict = await probePreviewPort(url);
      if (cancelled) return;

      if (verdict === 'reachable') {
        setStatus('ready');
        return;
      }
      if (!shouldRetryStaticFileHealth(attempts)) {
        setStatus('unavailable');
        return;
      }
      timer = setTimeout(probe, STATIC_FILE_HEALTH_RETRY_MS);
    }

    void probe();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [targets, retryNonce]);

  // `status` is about the SERVER, so it rightly survives a file switch. The
  // authenticated URL does not: it resolves in an effect and still names the
  // previous file for one render. Handing that over frames the page the user
  // just navigated away from.
  const addressesThisFile = authenticatedUrlAddresses(authenticatedUrl, targets?.previewUrl);

  return {
    url: status === 'ready' && addressesThisFile ? authenticatedUrl : null,
    status,
    retry,
  };
}
