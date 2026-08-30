/**
 * The connectors a craft plugs into — STATIC MOCK DATA for the UI/UX phase.
 *
 * Nothing here is fetched and nothing reflects the viewer's account: this
 * module answers "what does this craft touch?", never "have I connected it?".
 * The real flow reads the project's connectors through the SDK
 * (`AdminConnector`, `ConnectorAppIcon`) and can then show per-connector state.
 * Until it does, the UI must not imply a connection that does not exist.
 *
 * Two tables, deliberately normalized:
 *   - {@link CONNECTORS} — one entry per third-party app: display name + mark.
 *   - `Craft.connectors` — per-craft ids paired with what THAT craft does
 *     through the app. The role is per-pairing, not per-app: GitHub is
 *     "opens issues and PRs" for Error Triage and "opens the upgrade PR" for
 *     Dependency Watch.
 *
 * String-only on purpose — no icon component imports — so this stays safe to
 * read from a server component, unlike `crafts-catalog.ts`.
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

/** Every app the mock catalog references, keyed by id. */
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

/** One app a craft uses, and what the craft does through it. */
export interface CraftConnector {
  /** Key into {@link CONNECTORS}. */
  id: string;
  /**
   * What this craft does through this app — one clause, imperative, ≤ 24 chars
   * so the row never wraps at the modal's width.
   */
  role: string;
}

/**
 * Resolves a craft's connector to its registry entry. Falls back to a
 * name-from-id entry with no mark so an id that outlives its registry row
 * renders initials instead of crashing the modal.
 */
export function connectorFor(use: CraftConnector): Connector {
  return CONNECTORS[use.id] ?? { id: use.id, name: use.id };
}

/** Two-letter monogram for a connector with no mark — the `ProviderLogo` fallback. */
export function connectorInitials(connector: Connector): string {
  const words = connector.name.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return connector.name.slice(0, 2).toUpperCase();
}
