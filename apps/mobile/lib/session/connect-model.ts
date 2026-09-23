/**
 * connect-model — the URL `ConnectProviderSheet`'s Continue button opens.
 *
 * Web has its project provider modal. Mobile has no gateway model screen
 * (mobile ships core features only), so a gateway project opens web's routed
 * twin of that modal, `/projects/:id/customize/models`, in the in-app browser
 * (COR-125/COR-158 Task 9). Pure URL builder only — `bun test` cannot load
 * `expo-web-browser` (pulls in react-native), so the browser call itself
 * lives at the call site (`ConnectProviderSheet.tsx`), same as
 * `web-account-links.ts` / `web-project-links.ts`.
 */
export function projectModelsWebUrl(frontendUrl: string, projectId: string): string {
  return `${frontendUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(projectId)}/customize/models`;
}
