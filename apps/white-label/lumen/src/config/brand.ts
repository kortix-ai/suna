/**
 * The white-label seam: name and tagline. Colors, radius and fonts live in
 * `src/config/theme.ts`. The Kortix deployment is server config
 * (`KORTIX_API_URL` in Convex and Next.js), never a browser setting.
 */
export const BRAND = {
  /** Product name shown in the UI. */
  name: 'Lumen',
  /** One-line tagline on the auth/landing screen. */
  tagline: 'AI for legal teams.',
  /** The marketing subline. */
  subline: 'Review a data room in an afternoon. Every answer cites the clause.',
  /**
   * A subprocessor line for the Security page, for a partner whose contracts
   * name its infrastructure providers (for example "Agent sessions run on
   * Kortix."). Null: no line. Firms never see the platform otherwise.
   */
  subprocessorNote: null as string | null,
} as const;

export type Brand = typeof BRAND;

/** The model picker's provider line: Kortix-managed models show the brand's name. */
export function brandProviderLabel(model: { providerID: string; providerName: string }): string {
  return model.providerID === 'kortix' ? BRAND.name : model.providerName;
}

/** A `<provider>/<model>` id as Lumen shows it: Kortix-managed models drop their provider prefix. */
export function brandModelId(id: string): string {
  return id.startsWith('kortix/') ? id.slice('kortix/'.length) : id;
}
