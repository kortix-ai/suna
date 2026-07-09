// Canonical OpenRouter app attribution.
//
// OpenRouter groups usage into a leaderboard "app" keyed on the `HTTP-Referer`
// (aka `http-referer`) header, with `X-Title` as the display name. If that
// referer is derived from a per-deployment URL, every environment registers as a
// SEPARATE app: dev trycloudflare tunnels, api-prod.kortix.com, api.kortix.com,
// kortix.ai, etc. — which is exactly the fragmentation we had (a dozen different
// "Kortix" apps splitting our token attribution).
//
// To keep ALL Kortix OpenRouter traffic under ONE app no matter where it runs,
// these values are HARDCODED (never env-derived) and used at every site that
// talks to OpenRouter. Pinned to the dominant existing app: https://www.kortix.com.
//
// Do not swap these for config.KORTIX_URL / config.FRONTEND_URL — that is what
// caused the split in the first place.
export const OPENROUTER_APP_REFERER = 'https://www.kortix.com';
export const OPENROUTER_APP_TITLE = 'Kortix';
