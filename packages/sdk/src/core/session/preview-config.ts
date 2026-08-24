/**
 * How this deployment addresses previews, fetched once from `GET /v1/p/config`.
 *
 * The preview hostname shape (`{env}-p{port}-{sandbox}.{domain}`) is a property
 * of the deployment, not of the client: it depends on the wildcard domain the
 * operator serves and on which environment the API is. Re-deriving it here from
 * `backendUrl` would mean two implementations of one rule, which is how they
 * drift. So the API states it as a template and this caches the answer.
 *
 * `previewUrl()` is synchronous — a React render calls it — so the fetch cannot
 * happen there. `ensureReady()` warms this first, and until it resolves callers
 * get the path form, which still works for everything that is not a browser.
 */
import { backendApi } from '../http/api-client';

interface PreviewConfigResponse {
  preview_url_template?: string | null;
}

const templates = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

/**
 * Cache key: the backend URL without trailing slashes, stripped LINEARLY. The
 * regex form (`/\/+$/`) backtracks quadratically on adversarial input (CodeQL
 * js/polynomial-redos), and this runs on a host-supplied string.
 */
function key(backendUrl: string): string {
  let end = backendUrl.length;
  while (end > 0 && backendUrl.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return backendUrl.slice(0, end);
}

/**
 * The cached template for a backend, or null when this deployment serves none —
 * and also null before the first `load` resolves. Both mean "use the path form",
 * which is why they need no distinction at the call site.
 */
export function cachedPreviewUrlTemplate(backendUrl: string): string | null {
  return templates.get(key(backendUrl)) ?? null;
}

/**
 * Whether this backend has ANSWERED yet — as opposed to "answered null", which
 * is a real answer meaning "this deployment serves no preview domain".
 *
 * The two look identical through `cachedPreviewUrlTemplate`, and conflating them
 * is how a session gets stuck: during a rolling deploy the first `ensureReady()`
 * can hit a task that predates `/v1/p/config`, and without this the handle would
 * keep building path-proxy URLs for the rest of its life even though every later
 * request would have been answered by a new task.
 */
export function hasPreviewConfig(backendUrl: string): boolean {
  return templates.has(key(backendUrl));
}

/**
 * Fetch and cache the template. Concurrent callers share one request; a failed
 * fetch caches nothing, so a deployment that was briefly unreachable is asked
 * again rather than being remembered as having no preview domain.
 */
export async function loadPreviewUrlTemplate(backendUrl: string): Promise<string | null> {
  const cacheKey = key(backendUrl);
  const cached = templates.get(cacheKey);
  if (cached !== undefined) return cached;
  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const request = (async () => {
    try {
      const response = await backendApi.get<PreviewConfigResponse>('/p/config', {
        showErrors: false,
        // A deployment without a preview domain, and an API too old to know the
        // route, are both ordinary answers — not incidents to report.
        errorContext: { operation: 'load preview config', silent: true },
      });
      if (!response.success) return null;
      const template = typeof response.data?.preview_url_template === 'string'
        ? response.data.preview_url_template
        : null;
      templates.set(cacheKey, template);
      return template;
    } catch {
      // An older API has no such route, and a network blip is not an answer.
      // Leave the cache empty so the next ensureReady() asks again.
      return null;
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, request);
  return request;
}

/** Drop everything remembered — for tests and for a host re-pointing its API. */
export function resetPreviewConfigCache(): void {
  templates.clear();
  inFlight.clear();
}
