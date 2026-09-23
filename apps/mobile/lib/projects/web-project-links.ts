/**
 * URL builders for the project surfaces mobile hands off to web: project
 * members and the project's "Customize" hub. Mobile has no in-app screens
 * for these (COR-120/COR-123/COR-160 — "less is more; configuration lives on
 * the web"): the project Settings page (`SettingsNavPage`) opens them in the
 * in-app browser (`expo-web-browser`).
 */

/** `${frontendUrl}/projects/<projectId>/members`, id encoded. */
export function projectMembersWebUrl(frontendUrl: string, projectId: string): string {
  return `${frontendUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(projectId)}/members`;
}

/** `${frontendUrl}/projects/<projectId>/customize`, id encoded. */
export function projectCustomizeWebUrl(frontendUrl: string, projectId: string): string {
  return `${frontendUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(projectId)}/customize`;
}
