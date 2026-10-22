'use client';

import { convexClient } from '@convex-dev/better-auth/client/plugins';
import { organizationClient, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/** Better Auth in the browser: email + password, two-step sign-in (TOTP) and organizations, served at /api/auth. */
export const authClient = createAuthClient({
  plugins: [convexClient(), organizationClient(), twoFactorClient()],
});
