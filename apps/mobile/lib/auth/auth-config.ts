/**
 * Auth method / provider configuration.
 *
 * Build default: email methods from EXPO_PUBLIC_AUTH_METHODS (comma list of
 * "magic" / "password", default both); Google and Apple (iOS) always shown.
 *
 * A self-hosted instance chosen on the auth screen renders what its web auth
 * page renders: its own AUTH_METHODS / AUTH_PROVIDERS from the web runtime
 * config (see lib/deployment).
 */

import { authOptionsFor } from '@/lib/deployment/deployment';
import { activeDeployment } from '@/lib/deployment/store';

export type AuthMethod = 'magic' | 'password';

const options = authOptionsFor(activeDeployment, {
  EXPO_PUBLIC_AUTH_METHODS: process.env.EXPO_PUBLIC_AUTH_METHODS,
});

export const magicLinkEnabled = options.magic;
export const passwordEnabled = options.password;
export const googleEnabled = options.google;
export const appleEnabled = options.apple;
