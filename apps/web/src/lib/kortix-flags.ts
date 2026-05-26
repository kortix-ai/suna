/**
 * Kortix-cloud-only feature flags.
 *
 * These gate UI that's specific to the Kortix-hosted cloud frontend and
 * should NOT ship to self-hosters by default. Each flag is read from a
 * NEXT_PUBLIC_ env var (inlined at build time) and defaults to off, so any
 * deployment that doesn't explicitly opt in stays neutral.
 *
 * Add new flags here whenever cloud-specific copy, contact info, or branding
 * needs to be conditionally shown, so the gating logic lives in one place.
 */

/**
 * Show the founder's personal contact surfaces — the floating CEO concierge
 * widget on the projects pages, the "Personal help" section in the Support
 * dialog, and any other "hey, I'm Marko" UI. Self-hosters should never see
 * the maintainer's face by default.
 *
 * Enable on the cloud frontend with: NEXT_PUBLIC_KORTIX_PERSONAL_CONTACT=true
 */
export const SHOW_PERSONAL_CONTACT =
  process.env.NEXT_PUBLIC_KORTIX_PERSONAL_CONTACT === 'true';
