import { platformConfig } from './config';
import { platformRequestHeaders } from './transport';

/** A request the host performs itself, with the headers the SDK would send. */
export interface AuthenticatedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * The URL plus the SDK's request headers (bearer, client version,
 * impersonation) for a request the host sends itself: a download streamed to
 * disk, or a WebView source. Rejects a URL outside the configured backend
 * origin, so the token never reaches another host. Rejects without a token.
 * Header names are lowercase.
 */
export async function authenticatedRequest(url: string): Promise<AuthenticatedRequest> {
  // A relative backend URL (a same-origin web host) resolves against the page.
  // Without a page it throws: no credentials for an origin the SDK cannot name.
  const backend = new URL(platformConfig().backendUrl, globalThis.location?.href);
  const target = new URL(url);
  if (target.origin !== backend.origin) {
    throw new Error(`Refusing to attach credentials to a URL outside the Kortix backend: ${target.origin}`);
  }
  const { headers } = await platformRequestHeaders(url);
  return { url, headers: Object.fromEntries(headers.entries()) };
}
