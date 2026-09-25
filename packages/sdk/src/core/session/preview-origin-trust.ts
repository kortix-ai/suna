/**
 * Which preview origins may receive the caller's credential.
 *
 * A preview ORIGIN (`{env}-p{port}-{sandbox}.{domain}`, or the local
 * `p{port}-{sandbox}.localhost:{port}`) cannot see the API's host-only
 * `__preview_session` cookie, so its first request carries the bearer as a
 * one-shot `?token`. That token is a full account credential, so the decision
 * to attach it must rest on the deployment's own answer — the template from
 * `GET /v1/p/config`, or the configured local backend — and never on the shape
 * of the hostname alone. Any host can be named `p3000-something.example`.
 *
 * Internal: not exported from a public entry point.
 */
import { platformConfig } from '../http/config';
import { isSubdomainPreviewUrl } from './preview';
import { knownPreviewUrlTemplates, loadPreviewUrlTemplate } from './preview-config';

const LOCAL_PREVIEW_HOST = /^p\d{1,5}-[a-z0-9-]+\.localhost$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `origin` (scheme + host + port, no path) is one the template builds.
 * The template's literal text must match exactly; `{port}` matches digits and
 * `{sandbox}` one hostname label.
 */
function originMatchesTemplate(origin: string, template: string): boolean {
  if (!template.includes('{port}') || !template.includes('{sandbox}')) return false;
  const schemeEnd = template.indexOf('://');
  if (schemeEnd <= 0) return false;
  const scheme = template.slice(0, schemeEnd).toLowerCase();
  if (scheme !== 'https' && scheme !== 'http') return false;
  // Compare origins only: a path or trailing slash in the template is ignored.
  const authority = (template.slice(schemeEnd + 3).split('/')[0] ?? '').toLowerCase();
  const source = `${scheme}://${authority}`
    .split('{port}')
    .map((part) => part.split('{sandbox}').map(escapeRegExp).join('[a-z0-9-]+'))
    .join('\\d{1,5}');
  return new RegExp(`^${source}$`).test(origin);
}

function isLocalBackend(backendUrl: string): URL | null {
  try {
    const url = new URL(backendUrl);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? url : null;
  } catch {
    return null;
  }
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

/**
 * Pure trust decision for a preview-origin URL.
 *
 * - Deployed form: the URL's origin must be one an advertised template builds.
 * - Local form: `p{port}-{sandbox}.localhost` on the SAME port as a configured
 *   local backend — that host resolves to the viewer's own machine, where the
 *   local API serves it.
 */
export function isTrustedPreviewOrigin(
  candidateUrl: string,
  input: { templates: readonly string[]; backendUrls: readonly string[] },
): boolean {
  let url: URL;
  try {
    url = new URL(candidateUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;

  if (LOCAL_PREVIEW_HOST.test(url.hostname)) {
    return input.backendUrls.some((backendUrl) => {
      const backend = isLocalBackend(backendUrl);
      return backend !== null && effectivePort(backend) === effectivePort(url);
    });
  }

  return input.templates.some((template) => originMatchesTemplate(url.origin, template));
}

/**
 * Whether `previewUrl` should carry the one-shot `?token`.
 *
 * Asks the configured backend for its preview template first when it has not
 * answered yet. A URL that has the preview shape but no deployment behind it
 * gets no credential; the caller opens it bare and the destination answers for
 * itself.
 */
export async function shouldAttachPreviewToken(
  previewUrl: string,
  options: { serverUrl?: string } = {},
): Promise<boolean> {
  if (!isSubdomainPreviewUrl(previewUrl)) return false;
  const backendUrl = platformConfig().backendUrl;
  if (backendUrl) await loadPreviewUrlTemplate(backendUrl).catch(() => null);
  const backendUrls = [backendUrl, options.serverUrl].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return isTrustedPreviewOrigin(previewUrl, { templates: knownPreviewUrlTemplates(), backendUrls });
}
