'use client';

import { createKortix } from '@kortix/sdk';
import { getSessionToken } from './session';

/**
 * The one browser SDK client. It talks only to Lumen's same-origin proxy
 * (`src/app/api/kortix/[...path]/route.ts`); the browser never holds a Kortix
 * credential. `backendUrl` is path-only on purpose: for a same-origin path
 * the SDK sends the page's cookies (`credentials: 'same-origin'`), and the
 * Better Auth cookie is how the proxy knows the user.
 */
export const kortix = createKortix({
  backendUrl: '/api/kortix',
  getToken: async () => getSessionToken(),
});
