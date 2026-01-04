import posthog from 'posthog-js';

if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: '/ingest',
    ui_host: 'https://eu.posthog.com',
    defaults: '2025-05-24',
    capture_exceptions: true, 
    debug: process.env.NODE_ENV === 'development',
    // Use localStorage only to avoid cookie header size issues (431 errors)
    // This prevents PostHog from storing data in cookies, which can cause headers to exceed size limits
    persistence: 'localStorage',
    // Disable session recording to reduce data storage
    disable_session_recording: true,
  });
}
