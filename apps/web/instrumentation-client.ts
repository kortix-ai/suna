import './sentry.client.config';
import * as Sentry from '@sentry/nextjs';

// Instrument client-side navigations for performance tracing
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
