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

/**
 * Project and account creation live on the web (KRTX-246): mobile has no
 * create form, no GitHub connect or import. Every create entry point opens
 * one of these two pages in an in-app auth session. Web never redirects to
 * `WEB_CREATE_RETURN_URL`: the user comes back by closing the browser, and
 * the app then refetches (`useWebCreateHandoff`).
 */
export const WEB_CREATE_RETURN_URL = 'kortix://web';

/**
 * Web's create-project page, `/new`. With an account, `?account=<id>`
 * (web `readAccountParam`) preselects it — the account the user was on.
 */
export function newProjectWebUrl(frontendUrl: string, accountId?: string | null): string {
  const url = `${frontendUrl.replace(/\/$/, '')}/new`;
  return accountId ? `${url}?account=${encodeURIComponent(accountId)}` : url;
}

/**
 * Web has no create-account route: "New account" is a button on the account
 * hub's account list, a modal over any signed-in page opened by an empty
 * `?accountId=` (web `stores/account-panel-store.ts`). `/projects/start`
 * keeps the query when it forwards to the user's project, so the hub opens
 * there, one tap from the create form.
 */
export function newAccountWebUrl(frontendUrl: string): string {
  return `${frontendUrl.replace(/\/$/, '')}/projects/start?accountId=`;
}
