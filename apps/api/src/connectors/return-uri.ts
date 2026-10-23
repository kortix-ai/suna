import { config } from '../config';

/**
 * A page a finished sign-in may send the browser to: the web app, or the
 * mobile app's `kortix:` scheme. `undefined` for anything else, so a caller
 * never becomes an open redirect.
 */
export function allowedReturnUri(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const uri = new URL(value);
    if (uri.protocol === 'kortix:') return uri.href;
    const allowed = new Set([new URL(config.FRONTEND_URL).origin, 'https://kortix.com', 'https://dev.kortix.com', 'https://staging.kortix.com']);
    return allowed.has(uri.origin) ? uri.href : undefined;
  } catch {
    return undefined;
  }
}
