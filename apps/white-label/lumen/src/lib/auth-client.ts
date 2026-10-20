'use client';

import { convexClient } from '@convex-dev/better-auth/client/plugins';
import { organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/** Better Auth in the browser: email + password and organizations, served at /api/auth. */
export const authClient = createAuthClient({
  plugins: [convexClient(), organizationClient()],
});
