/**
 * The mobile app's in-app browser hand-offs to a Customize page.
 *
 * The app opens a page with `?return_to=kortix://…` in an in-app auth
 * session. When the page sends the browser to `return_to`, the auth session
 * closes itself and the user is back in the app:
 * - Models (`models/app-return-bar.tsx`): once the project has a usable model.
 * - Connectors (`connectors/connectors-app-return-bar.tsx`): when the user taps
 *   Done, after the last connector.
 *
 * Only the `kortix:` scheme is accepted: `return_to` is user-controlled query
 * input, and any other value must never become a redirect target.
 */
const MAX_RETURN_URL_LENGTH = 256;

export function parseAppReturnUrl(raw: string | null | undefined): string | null {
  if (!raw || raw.length > MAX_RETURN_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'kortix:') return null;
  return raw;
}
