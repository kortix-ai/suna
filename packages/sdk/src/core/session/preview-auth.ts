/**
 * Preview-proxy cookie exchange (side-effecting).
 *
 * `preview.ts` next door is pure — it only decides endpoints and token rules.
 * This module performs the actual `POST /…/p/auth` that mints the
 * `__preview_session` cookie, so the two concerns stay separable and the pure
 * helpers remain trivially testable.
 *
 * Two callers need this, for different reasons:
 *   - `react/use-authenticated-preview-url` — keeps an iframe's cookie warm on
 *     an interval while a preview is mounted.
 *   - opening a workspace file in a real browser tab — a one-shot mint, because
 *     nothing has necessarily rendered a preview for that sandbox yet, so no
 *     cookie may exist at click time.
 *
 * Without the one-shot case, "open in a new tab" can only hand the browser
 * bytes it already has (a `blob:` URL), which is not an address: it cannot be
 * reloaded, bookmarked, or sent to anyone.
 */

import { getAuthToken } from '../http/auth';
import { buildPreviewAuthEndpoint } from './preview';

/**
 * Mint the `__preview_session` cookie for `previewUrl`'s proxy origin.
 *
 * Resolves `true` when the cookie was (re)issued, `false` when the URL is not a
 * trusted preview-proxy URL, no token is available, or the exchange failed.
 * Never throws — callers treat a false as "proceed and let the proxy answer",
 * matching how the interval refresh in `use-authenticated-preview-url` already
 * tolerates a failed refresh.
 */
export async function ensurePreviewSessionCookie(
  previewUrl: string,
  options: { serverUrl?: string } = {},
): Promise<boolean> {
  const authEndpoint = buildPreviewAuthEndpoint(previewUrl, options.serverUrl);
  if (!authEndpoint) return false;

  const token = await getAuthToken();
  if (!token) return false;

  try {
    const response = await fetch(authEndpoint, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}
