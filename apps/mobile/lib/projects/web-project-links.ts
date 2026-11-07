/**
 * URL builders for the project surfaces mobile hands off to web: the
 * project's "Customize" hub and its Connectors page. Mobile has no in-app
 * screens for these (COR-120/COR-123/COR-160 — "less is more; configuration lives on
 * the web"): the project Settings page (`SettingsNavPage`) opens them in the
 * in-app browser (`expo-web-browser`).
 */

/** `${frontendUrl}/workspaces/<projectId>/customize`, id encoded. */
export function projectCustomizeWebUrl(frontendUrl: string, projectId: string): string {
  return `${frontendUrl.replace(/\/$/, '')}/workspaces/${encodeURIComponent(projectId)}/customize`;
}

/**
 * The project drawer's Connectors row: web's Customize → Connectors page,
 * opened in an in-app auth session. Mobile has no connector catalog; web
 * owns connecting. With `return_to`, the page shows a "Done" bar that sends
 * the browser to that `kortix://` URL, and the auth session closes itself on
 * the redirect. The user taps it once, after the last connector.
 */
export const CONNECTORS_RETURN_URL = 'kortix://connectors';
export const CONNECTORS_DONE_URI = 'kortix://connectors/done';

/** `${frontendUrl}/workspaces/<projectId>/admin/connectors[?return_to=…]`, id encoded. */
export function projectConnectorsWebUrl(
  frontendUrl: string,
  projectId: string,
  returnTo?: string
): string {
  const url = `${frontendUrl.replace(/\/$/, '')}/workspaces/${encodeURIComponent(projectId)}/admin/connectors`;
  return returnTo ? `${url}?return_to=${encodeURIComponent(returnTo)}` : url;
}

/**
 * Workspace creation lives on the web (KRTX-246): mobile has no create form,
 * no GitHub connect or import. Every create entry point opens web `/workspaces/new` in
 * an in-app auth session. Web never redirects to `WEB_CREATE_RETURN_URL`:
 * the user comes back by closing the browser, and the app then refetches
 * (`useWebCreateHandoff`).
 */
export const WEB_CREATE_RETURN_URL = 'kortix://web';

/**
 * Web's create-workspace page, `/workspaces/new`. No `?account=`: a workspace is its own
 * account, so `/workspaces/new` creates the whole workspace (web reuses the newest
 * account the user owns that has no project, else creates one).
 */
export function newWorkspaceWebUrl(frontendUrl: string): string {
  return `${frontendUrl.replace(/\/$/, '')}/workspaces/new`;
}
