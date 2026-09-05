/**
 * Display names and marks for the third-party apps a template plugs into.
 *
 * This is a PRESENTATION table, not data: the template's requirement list comes
 * from its `kortix.yaml` through `MarketplaceTemplate.connectors`, and this module only
 * answers "what is this app called, and what is its logo". An app with no row
 * here still renders — {@link connectorFor} falls back to initials — so a template
 * may require anything without a code change.
 *
 * Whether the VIEWER has connected an app is a different question, answered by
 * the project's own connector list (`listConnectors`) at the render site. The
 * two are deliberately not merged: a template's requirements are global, a
 * connection is per-project.
 *
 * String-only on purpose — no icon component imports — so this stays safe to
 * read from a server component.
 */

export interface Connector {
  /** Registry key, also the mark's filename under `public/connector-logos`. */
  id: string;
  /** Display name. Shortened where the legal name adds nothing ("Search Console"). */
  name: string;
  /**
   * Local monochrome mark under `public/connector-logos`, or `undefined` to
   * fall back to initials.
   *
   * The files are single-path `fill="currentColor"` SVGs — the same convention
   * as `public/provider-icons/*.svg`. Loaded through `<img>`, `currentColor`
   * resolves to the SVG document's own default (black), which is why every
   * render site pairs them with `dark:invert` exactly as `ProviderLogo` does.
   *
   * Marks come from simple-icons 11.14.0 (CC0), normalized to that convention:
   *
   *   curl -sL https://cdn.jsdelivr.net/npm/simple-icons@11.14.0/icons/<slug>.svg \
   *     | sed -e 's| role="img"||' -e 's|<title>[^<]*</title>||' \
   *           -e 's|<path |<path fill="currentColor" |g' \
   *           -e 's|<svg |<svg width="24" height="24" |' \
   *     > apps/web/public/connector-logos/<slug>.svg
   *
   * Vet a new mark at 16px before shipping it: a dense logo (Datadog's framed
   * dog, Snyk's hound) survives monochrome, but anything with a wordmark or
   * fine interior detail turns to speckle at this size — leave `logo` unset and
   * take the initials tile rather than ship a smudge. The npm mark was dropped
   * for the opposite reason: a solid square inverts into a white block.
   */
  logo?: string;
}

const mark = (id: string, name: string): Connector => ({
  id,
  name,
  logo: `/connector-logos/${id}.svg`,
});

/** The apps we ship a mark for, keyed by the Composio toolkit slug. */
export const CONNECTORS: Record<string, Connector> = {
  sentry: mark('sentry', 'Sentry'),
  datadog: mark('datadog', 'Datadog'),
  newrelic: mark('newrelic', 'New Relic'),
  github: mark('github', 'GitHub'),
  slack: mark('slack', 'Slack'),
  linear: mark('linear', 'Linear'),
  googlesearchconsole: mark('googlesearchconsole', 'Search Console'),
  googleanalytics: mark('googleanalytics', 'Google Analytics'),
  snyk: mark('snyk', 'Snyk'),
  resend: mark('resend', 'Resend'),
  stripe: mark('stripe', 'Stripe'),
  quickbooks: mark('quickbooks', 'QuickBooks'),
  gmail: mark('gmail', 'Gmail'),
  hubspot: mark('hubspot', 'HubSpot'),
  intercom: mark('intercom', 'Intercom'),
  zendesk: mark('zendesk', 'Zendesk'),
  notion: mark('notion', 'Notion'),
};

/**
 * Resolves an app id to its registry entry. Falls back to a name-from-id entry
 * with no mark, so an app we ship no logo for renders initials instead of
 * crashing the modal. Called with whatever the template's manifest declared, which
 * is why the fallback is the normal case rather than the error case.
 */
export function connectorFor(id: string): Connector {
  const key = id.trim().toLowerCase();
  return CONNECTORS[key] ?? { id: key, name: id };
}

/** Two-letter monogram for a connector with no mark — the `ProviderLogo` fallback. */
export function connectorInitials(connector: Connector): string {
  const words = connector.name.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return connector.name.slice(0, 2).toUpperCase();
}
