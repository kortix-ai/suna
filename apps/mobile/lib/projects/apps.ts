/**
 * Apps on the mobile surface — the pieces of the Apps page that `bun test`
 * can run (pure logic only; the page component cannot load under bun test).
 *
 * An App is a project-scoped deployed application (`GET /projects/:id/apps`,
 * `App` in @kortix/sdk; web's `apps-view.tsx`). The mobile page lists them and
 * opens one by minting a short-lived access session and opening its URL in a
 * browser — web opens the same URL in an iframe.
 */

import type { App } from '@kortix/sdk';

/** The runtime-state label of an App row, in the words web's `appStatus` uses. */
export type AppStatus = 'Not deployed' | 'Running' | 'Suspended';

/**
 * Three states, the same three web's App cards show: never deployed,
 * deployed and running, deployed and stopped. Anything else (`viewer_can_access`,
 * budgets) is not a runtime state and stays off this row. A static App has
 * no runtime and serves whatever `desired_state` says, so deployed = Running.
 */
export function appStatus(
  app: Pick<App, 'active_deployment_id' | 'desired_state' | 'hosting_type'>,
): AppStatus {
  const deployed = Boolean(app.active_deployment_id);
  if (!deployed) return 'Not deployed';
  return app.desired_state === 'running' || app.hosting_type === 'static' ? 'Running' : 'Suspended';
}

/** The viewer may see this App in the list but not open it (`viewer_can_access === false`). */
export class AppAccessDeniedError extends Error {
  constructor() {
    super('You do not have access to this app');
    this.name = 'AppAccessDeniedError';
  }
}

/** The collaborators `openApp` needs, so a test can fake both hops. */
export interface OpenAppDeps {
  /** Mint the short-lived access session (SDK `createAppAccessSession`). */
  createSession: () => Promise<{ url: string }>;
  /** Open a URL in a browser (`lib/utils/open-link`). */
  openLink: (url: string) => Promise<void>;
}

/**
 * Open one App: deny what the viewer may not open (before any request), mint
 * the access session, open its URL. Throws so the page can toast; the access
 * session's own error (a 403 for an App listed but not openable) propagates.
 */
export async function openApp(
  app: Pick<App, 'viewer_can_access'>,
  deps: OpenAppDeps,
): Promise<void> {
  if (app.viewer_can_access === false) throw new AppAccessDeniedError();
  const session = await deps.createSession();
  await deps.openLink(session.url);
}
