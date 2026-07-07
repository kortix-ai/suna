/**
 * The white-label seam. This is the ONLY file a customer touches to rebrand —
 * name, accent, and which Kortix deployment to point at. Everything else is
 * generic and flows through `@kortix/sdk`.
 */
export const BRAND = {
  /** Product name shown in the UI. */
  name: 'Lumen',
  /** One-line tagline on the auth/landing screen. */
  tagline: 'Your agents, your repos, your brand.',
  /** Kortix API base URL (the SDK `backendUrl`). */
  apiUrl: process.env.NEXT_PUBLIC_KORTIX_API_URL ?? 'https://api.kortix.com/v1',
  /** Accent color (CSS). */
  accent: '#6366f1',
} as const;

export type Brand = typeof BRAND;

/**
 * The backend URL the SDK should target, per mode:
 *  - **direct mode** (`wrapperMode: false`) → `BRAND.apiUrl`, a real Kortix
 *    deployment; the browser holds a pasted PAT and talks to it directly.
 *  - **wrapper mode** (`wrapperMode: true`) → this app's own same-origin BFF
 *    proxy (`src/app/api/kortix/[...path]/route.ts`), which holds the real
 *    Kortix API key server-side and re-authenticates every request against
 *    this app's own login session instead.
 *
 * Always resolves to an ABSOLUTE url. The SDK parses `backendUrl` with
 * `new URL()` in a few places (proxy/preview URL building) which requires an
 * absolute base — a bare `/api/kortix` would throw there, so wrapper mode
 * builds `${window.location.origin}/api/kortix` instead.
 */
export function resolveApiUrl(wrapperMode: boolean): string {
  if (!wrapperMode) return BRAND.apiUrl;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/api/kortix`;
}
