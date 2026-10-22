import { getSessionHealth } from '../session/health';
import { proxyLocalhostUrl, rewriteLocalhostUrl } from '../session/url';

import { getSandboxUrlForExternalId } from '../session/server-store/url-helpers';

import type { SessionBindingContext } from './session-context';
export function bindSessionPreview(ctx: SessionBindingContext) {
  return {
    // ── runtime health + preview (the session owns its runtime) ──────────
    /**
     * Liveness/readiness of THIS session's runtime (`GET /kortix/health`).
     * Unlike `.previewUrl()`/`.proxyUrl()`/`.runtime`, this never throws
     * `SessionNotReadyError` — a health poller (e.g. a header dot ticking
     * every 15s on a fresh inline handle) needs to be callable BEFORE the
     * session has ever resolved a runtime. It degrades to the same graceful
     * `{ status: 0, ok: false }` shape `getSessionHealth` already returns for
     * "no URL yet", instead of forcing every caller to guard with `ctx.ensureReady()`.
     */
    health: (init?: RequestInit) =>
      getSessionHealth(ctx.tryResolveReady()?.runtimeUrl ?? null, init),
    /** Proxy/preview URL for a port THIS session's runtime exposes. */
    previewUrl: (port: number, path = '/') =>
      rewriteLocalhostUrl(
        port,
        path,
        ctx.resolvePreviewOptsForSandbox(ctx.requireReady('previewUrl').sandboxId),
      ),
    /** Rewrite a localhost URL the agent printed into a reachable proxy URL. */
    proxyUrl: (url?: string) =>
      proxyLocalhostUrl(
        url,
        ctx.resolvePreviewOptsForSandbox(ctx.requireReady('proxyUrl').sandboxId),
      ),
    /**
     * The AUTHENTICATED backend proxy URL for a given sandbox port of THIS
     * session's runtime: `${backendUrl}/p/{externalId}/{port}` — no browser
     * preview-origin rewriting. This is the URL a local port-forward proxy
     * dials with the caller's own bearer token (see `getSandboxUrlForExternalId`).
     * Use `previewUrl()`/`proxyUrl()` instead for a browser tab.
     */
    sandboxPortUrl: (port: number) =>
      getSandboxUrlForExternalId(ctx.requireReady('sandboxPortUrl').sandboxId, port),
  };
}
