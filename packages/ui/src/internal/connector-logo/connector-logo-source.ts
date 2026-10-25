import { faviconUrlForHostname } from '../../lib/favicon';

/**
 * Which logo a connector shows. ONE rule for every surface — catalogue card,
 * app page, connector page, Connected list, account rows, pickers, channel
 * heroes, approvals — so an app looks the same wherever it appears.
 *
 * 1. A Kortix-built connector (Slack, Teams, Email, Telegram, Computer) shows
 *    its banner mark: the Slack and Teams brand components, the Phosphor
 *    envelope, plane and monitor glyphs (`ConnectorLogo` draws them). The
 *    files under `apps/web/public/connector-icons/<app>.svg` are the same
 *    marks, for consumers that need a URL, so an icon URL pointing at one is
 *    read as that app too.
 * 2. Else the app's own icon URL: the catalogue record's, or the one the API
 *    resolved for an installed connector (`AdminConnector.iconUrl`).
 * 3. Else the favicon of a PUBLIC catalogue domain. Never of a connector's own
 *    URL: a custom MCP or API host may be private, and the favicon service
 *    would learn it (the API holds the same line, `connector-icon.ts`).
 * 4. Else the neutral fallback glyph.
 */

export type NativeConnectorApp = 'slack' | 'teams' | 'email' | 'telegram' | 'computer';

const NATIVE_APPS: readonly NativeConnectorApp[] = ['slack', 'teams', 'email', 'telegram', 'computer'];

function isNative(value: string | null | undefined): value is NativeConnectorApp {
  return !!value && (NATIVE_APPS as readonly string[]).includes(value);
}

/** Whatever a surface knows about the connector; every field optional. */
export interface ConnectorLogoSource {
  /** Connector slug (`kortix_email`, `computer`) or catalogue id (`native:email`). */
  slug?: string | null;
  /** `AdminConnector.provider`: `channel`, `computer`, `composio`, `mcp`, … */
  provider?: string | null;
  /** A channel connector's platform. */
  platform?: string | null;
  /** The Kortix app a catalogue record names (`DiscoverConnector.kortix.app`). */
  nativeApp?: string | null;
  /** The app's own icon URL, when the source has one. */
  icon?: string | null;
  /** A public catalogue domain (never a connector's own URL). */
  domain?: string | null;
}

export type ConnectorLogoKind =
  | { kind: 'native'; app: NativeConnectorApp }
  | { kind: 'image'; src: string }
  | { kind: 'none' };

export function nativeConnectorApp(source: ConnectorLogoSource): NativeConnectorApp | null {
  if (isNative(source.nativeApp)) return source.nativeApp;
  if (source.provider === 'computer') return 'computer';
  if (source.provider === 'channel' && isNative(source.platform)) return source.platform;
  const slug = (source.slug ?? '').toLowerCase();
  const match = /^(?:native:|kortix_)(slack|teams|email|telegram|computer)$/.exec(slug);
  if (match) return match[1] as NativeConnectorApp;
  if (slug === 'computer' || slug === 'computers') return 'computer';
  const file = /\/connector-icons\/(slack|teams|email|telegram|computer)\.svg$/.exec(source.icon ?? '');
  return file ? (file[1] as NativeConnectorApp) : null;
}

export function resolveConnectorLogo(source: ConnectorLogoSource): ConnectorLogoKind {
  const native = nativeConnectorApp(source);
  if (native) return { kind: 'native', app: native };
  if (source.icon) return { kind: 'image', src: source.icon };
  const domain = source.domain?.trim();
  return domain ? { kind: 'image', src: faviconUrlForHostname(domain) } : { kind: 'none' };
}

/** A catalogue record (Discover) as a logo source. */
export function discoverLogoSource(connector: {
  id?: string | null;
  slug?: string | null;
  icon?: string | null;
  domain?: string | null;
  kortix?: { app?: string | null } | null;
}): ConnectorLogoSource {
  return {
    slug: connector.id ?? connector.slug,
    nativeApp: connector.kortix?.app ?? null,
    icon: connector.icon,
    domain: connector.domain,
  };
}

/** An installed connector (`AdminConnector`) as a logo source. */
export function installedConnectorLogoSource(connector: {
  slug: string;
  provider?: string | null;
  platform?: string | null;
  iconUrl?: string | null;
}): ConnectorLogoSource {
  return {
    slug: connector.slug,
    provider: connector.provider,
    platform: connector.platform,
    icon: connector.iconUrl,
  };
}
