/**
 * The white-label seam: name and tagline. Colors, radius and fonts live in
 * `src/config/theme.ts`. The Kortix deployment is server config
 * (`KORTIX_API_URL` in Convex and Next.js), never a browser setting.
 */
export const BRAND = {
  /** Product name shown in the UI. */
  name: 'Lumen',
  /** One-line tagline on the auth/landing screen. */
  tagline: 'AI agents for finance, legal and research teams.',
} as const;

export type Brand = typeof BRAND;

/** The model picker's provider line: Kortix-managed models show the brand's name. */
export function brandProviderLabel(model: { providerID: string; providerName: string }): string {
  return model.providerID === 'kortix' ? BRAND.name : model.providerName;
}
