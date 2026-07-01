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
