/**
 * connect-model — the URL `ConnectProviderSheet`'s Continue button opens.
 *
 * Web has its project provider modal. Mobile has no gateway model screen
 * (mobile ships core features only), so a gateway project opens web's routed
 * twin of that modal, `/projects/:id/customize/models`, in an in-app auth
 * session (COR-125/COR-158 Task 9). With `return_to`, the web page redirects
 * to that `kortix://` URL once the project has a usable model, and the auth
 * session closes itself on the redirect. Pure URL builder only — `bun test`
 * cannot load `expo-web-browser` (pulls in react-native), so the browser call
 * itself lives at the call site (`ConnectProviderSheet.tsx`), same as
 * `web-account-links.ts` / `web-project-links.ts`.
 */

/** The auth session's redirect prefix; the page redirects to the full URI. */
export const PROVIDER_RETURN_URL = 'kortix://providers';
export const PROVIDER_CONNECTED_URI = 'kortix://providers/connected';

export function projectModelsWebUrl(
  frontendUrl: string,
  projectId: string,
  returnTo?: string,
): string {
  const url = `${frontendUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(projectId)}/customize/models`;
  return returnTo ? `${url}?return_to=${encodeURIComponent(returnTo)}` : url;
}

/**
 * The `kortix://` URLs that only close an in-app browser session: provider
 * connect (this file), connector connect (`ConnectorAuthSheet`) and the
 * project drawer's Connectors row (`kortix://connectors/done`). They have no
 * screen. On Android the URL also reaches the app as a deep link, so
 * `app/+native-intent.ts` must not route it (the router would show the
 * not-found screen).
 */
const BROWSER_RETURN_ROOTS = new Set(['providers', 'connectors']);

export function isBrowserReturnPath(path: string): boolean {
  const root = path
    .replace(/^kortix:\/\//, '')
    .replace(/^\/+/, '')
    .split(/[/?#]/)[0];
  return BROWSER_RETURN_ROOTS.has(root);
}
