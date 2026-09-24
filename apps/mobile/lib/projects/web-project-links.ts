/**
 * URL builders for the project surfaces mobile hands off to web: the
 * project's "Customize" hub and its Connectors page. Mobile has no in-app
 * screens for these (COR-120/COR-123/COR-160 — "less is more; configuration lives on
 * the web"): the project Settings page (`SettingsNavPage`) opens them in the
 * in-app browser (`expo-web-browser`).
 */

/** `${frontendUrl}/projects/<projectId>/customize`, id encoded. */
export function projectCustomizeWebUrl(frontendUrl: string, projectId: string): string {
  return `${frontendUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(projectId)}/customize`;
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

/** `${frontendUrl}/projects/<projectId>/customize/connectors[?return_to=…]`, id encoded. */
export function projectConnectorsWebUrl(
  frontendUrl: string,
  projectId: string,
  returnTo?: string
): string {
  const url = `${projectCustomizeWebUrl(frontendUrl, projectId)}/connectors`;
  return returnTo ? `${url}?return_to=${encodeURIComponent(returnTo)}` : url;
}
