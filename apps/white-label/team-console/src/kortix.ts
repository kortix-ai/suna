import { createKortix, kortixAppViewerToken } from '@kortix/sdk';

/**
 * The one client. Kortix is the identity and the data authority: every call
 * runs as the person who opened the App, capped by their own Kortix role.
 * `/_kortix/api/v1` is the Apps gate on this origin (vite.config.ts stands in
 * for it in local dev). No login, no backend, no token in this code.
 */
export const kortix = createKortix({
  backendUrl: '/_kortix/api/v1',
  getToken: kortixAppViewerToken(),
});
