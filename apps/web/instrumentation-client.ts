import './sentry.client.config';
import * as Sentry from '@sentry/nextjs';
import { installNavigationSessionGate } from '@/lib/auth/navigation-session-gate';

// Runs before hydration, so the App Router's first request already goes
// through it: a stale session refreshes before a navigation, not on /auth.
installNavigationSessionGate();

// Instrument client-side navigations for performance tracing
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
