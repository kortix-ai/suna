/**
 * ─────────────────────────────────────────────────────────────────────────
 *  WHITE-LABEL BRAND CONFIG
 * ─────────────────────────────────────────────────────────────────────────
 *  This is the single seam that re-skins the entire starter. Change the
 *  values below — name, workspace label, tagline, accent — and every surface
 *  (auth, shell, sidebar, home, session workbench, metadata) updates.
 *
 *  The product UI is a faithful mirror of the Kortix frontend; only the brand
 *  identity here and the API adapter in `src/lib/kortix.ts` are meant to be
 *  swapped per deployment.
 */

export interface Brand {
  /** Full product name, e.g. shown in metadata + auth. */
  name: string;
  /** Compact name used in dense chrome (sidebar, top bar). */
  shortName: string;
  /** Label for the user's workspace/org surface. */
  workspaceName: string;
  /** One-line positioning shown under the name on auth + home. */
  tagline: string;
  /** Two-word noun for what a "session" is, e.g. "agent session". */
  sessionNoun: string;
  /** Accent color (any CSS color) for the brand mark + subtle highlights. */
  accent: string;
  /** Foreground color used on top of the accent (mark glyph). */
  accentForeground: string;
  /** Tasteful "infrastructure by" credit; set to null to hide. */
  poweredBy: string | null;
}

export const brand: Brand = {
  name: 'Northstar',
  shortName: 'Northstar',
  workspaceName: 'Northstar Workspace',
  tagline: 'The agentic engineering workspace',
  sessionNoun: 'session',
  accent: 'oklch(0.205 0 0)',
  accentForeground: 'oklch(0.985 0 0)',
  poweredBy: 'Kortix',
};
