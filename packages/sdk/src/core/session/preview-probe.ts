/**
 * Is anything actually listening on a session's proxied port?
 *
 * An `<iframe>` cannot answer that. It fires `onLoad` when a document renders
 * and `onError` almost never, so a host that watches only the frame has exactly
 * one signal — silence — and silence covers two opposite states: a dev server
 * still compiling its first route (30-60s is normal) and a port with nothing
 * behind it. Every host that guessed between them from a stopwatch guessed
 * wrong on cold starts.
 *
 * This asks the proxy instead. The preview proxy answers `502/503/504` ITSELF
 * when it cannot open a connection to the port, so a negative verdict comes
 * back fast and does not depend on the app being quick. A positive verdict is
 * only ever as fast as the app.
 *
 * Deliberately NOT `authenticatedFetch`: the preview proxy authenticates a
 * browser with the `__preview_session` cookie, and an `Authorization` header
 * would make this a non-simple cross-origin request and cost a CORS preflight
 * on every probe. Same auth path the iframe itself uses.
 *
 * `probePreviewReady` at the bottom answers the neighbouring question — "is it
 * answering OK yet" — for hosts that gate a rendered surface on readiness. See
 * its own doc for why the two verdicts must stay separate.
 */

import { getAuthToken } from '../http/auth';
import { appendPreviewToken, isSubdomainPreviewUrl } from './preview';

/**
 * What one probe learned about a port.
 *
 * `unknown` is a first-class answer, not an error case: a CORS refusal, an
 * offline browser, an expired preview cookie, or a probe that outran its own
 * timeout all say nothing about the port. A caller must never turn `unknown`
 * into a failure verdict.
 */
export type PreviewPortProbe = 'reachable' | 'unreachable' | 'unknown';

/**
 * Default ceiling on a single probe, ms.
 *
 * The proxy's "nothing is listening" answer needs no upstream connection and
 * comes back in well under a second, so this bound never delays a real verdict.
 * It exists for the opposite case: an app that accepted the connection and then
 * stalled — which is itself already weak evidence the port is up, and holding
 * the socket open longer cannot change that.
 *
 * Deliberately SHORT. A caller decides a port is dead from repeated misses
 * inside some window of its own, and a probe whose ceiling approaches that
 * window can consume the caller's entire sampling budget in ONE stalled
 * sample. Three seconds leaves room for several samples inside any window
 * worth having. A probe that outruns it resolves `unknown` and can never
 * itself declare a port dead.
 */
export const PREVIEW_PROBE_TIMEOUT_MS = 3_000;

/**
 * The status-to-verdict rule, pure so it can be reasoned about without a
 * network:
 *
 * - `502/503/504` — the proxy could not reach the port. This is the only
 *   family that means "nothing is listening" (mirrors
 *   `isImmediateOfflineStatus`, which applies the same rule to the runtime's
 *   own health probe).
 * - `401/403` — the preview proxy's auth gate, i.e. OUR cookie, not the app.
 *   Reading these as failure would blame a user's app for our expired session.
 * - any other real HTTP status — a server accepted the connection and replied.
 *   A 404 or a 500 is the app answering, which is exactly what "the port is up"
 *   means.
 * - anything outside the HTTP range (`0` from an unreadable/opaque response, or
 *   a nonsense number) — no answer to classify.
 */
export function classifyPreviewProbeStatus(status: number): PreviewPortProbe {
  if (!Number.isFinite(status) || status < 100 || status > 599) return 'unknown';
  if (status === 502 || status === 503 || status === 504) return 'unreachable';
  if (status === 401 || status === 403) return 'unknown';
  return 'reachable';
}

/**
 * Probe one preview URL. Never throws and never rejects — every failure mode
 * collapses into `unknown`, so a caller's error handling is the same shape as
 * its "still waiting" handling.
 *
 * `HEAD` rather than `GET`: it is safe and idempotent, it carries no body, and
 * a server that refuses it (`405`, `501`) has still proved it is listening.
 */
export async function probePreviewPort(
  previewUrl: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<PreviewPortProbe> {
  if (!previewUrl) return 'unknown';
  if (options?.signal?.aborted) return 'unknown';

  const controller = new AbortController();
  const abort = () => controller.abort();
  options?.signal?.addEventListener('abort', abort);
  const timer = setTimeout(abort, options?.timeoutMs ?? PREVIEW_PROBE_TIMEOUT_MS);

  try {
    const res = await fetch(previewUrl, {
      method: 'HEAD',
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    });
    return classifyPreviewProbeStatus(res.status);
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener('abort', abort);
  }
}

/**
 * Is a preview endpoint answering OK *right now*?
 *
 * The sibling `probePreviewPort` answers a different question — "is anything
 * listening" — and deliberately treats `401/403` as `unknown` because those come
 * from the proxy's own auth gate. A host that gates a rendered surface on
 * readiness needs the stricter verdict: only a `2xx` means "show it". Everything
 * else, including our own auth failing, means "not yet — ask again".
 *
 * It also has to survive the auth form `probePreviewPort` cannot use. Subdomain
 * previews (`p{port}-{sandbox}.host`, the local-dev shape) never receive the
 * host-only `/v1/p` session cookie, so they authenticate with a one-shot
 * `?token` on the request itself, which the proxy then trusts in-memory for the
 * whole subdomain. Without it the probe `401`s forever, the gated surface never
 * renders, nothing ever carries a token, and the "starting…" state deadlocks.
 * The token goes in the query string, not an `Authorization` header, so the
 * request stays simple and costs no CORS preflight.
 *
 * Never throws: a rejected fetch is just "not ready", which is the same branch
 * a caller already has for a non-2xx.
 *
 * No timeout of its own — a caller drives this from a bounded retry loop and
 * owns the deadline. Pass `signal` to cancel an in-flight probe on unmount.
 */
export async function probePreviewReady(
  previewUrl: string,
  options?: {
    signal?: AbortSignal;
    /**
     * Token source for the subdomain form. Defaults to the SDK's platform
     * token seam; overridable so a caller (or a test) can supply its own
     * without reaching through global config.
     */
    getToken?: () => Promise<string | null>;
  },
): Promise<boolean> {
  if (!previewUrl) return false;
  if (options?.signal?.aborted) return false;

  try {
    let url = previewUrl;
    if (isSubdomainPreviewUrl(previewUrl)) {
      const token = await (options?.getToken ?? getAuthToken)();
      if (options?.signal?.aborted) return false;
      // No token is not a reason to skip: the proxy may already trust this
      // subdomain from an earlier tokened request.
      if (token) url = appendPreviewToken(previewUrl, token);
    }

    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    return res.ok;
  } catch {
    return false;
  }
}
