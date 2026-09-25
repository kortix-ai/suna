import type { AdminConnector } from '@kortix/sdk';

/** The provider glyph a connector falls back to when no logo is known. */
export type ConnectorGlyph = 'app' | 'automation' | 'mcp' | 'web' | 'chat' | 'email' | 'computer';

/**
 * What a connector's icon tile paints.
 *
 * - `image` — the logo the API returned in `iconUrl`. The API resolves it
 *   from the same sources the Discover tab shows (the Composio toolkit logo,
 *   the Pipedream app icon, or the Discover card for the host a direct
 *   connector calls), so a connected app looks like its catalogue card.
 * - `slack` — the Slack channel. The API stores no logo for channels, and the
 *   Slack mark is the one every Slack surface in the product already uses.
 * - `glyph` — no logo is known: the neutral provider glyph.
 */
export type ConnectorIconFace =
  { kind: 'image'; src: string } | { kind: 'slack' } | { kind: 'glyph'; glyph: ConnectorGlyph };

const PROVIDER_GLYPH: Record<AdminConnector['provider'], ConnectorGlyph> = {
  composio: 'app',
  pipedream: 'automation',
  mcp: 'mcp',
  openapi: 'web',
  postman: 'web',
  graphql: 'web',
  http: 'web',
  channel: 'chat',
  computer: 'computer',
};

export function connectorIconFace(
  connector: Pick<AdminConnector, 'provider' | 'platform' | 'iconUrl'>,
): ConnectorIconFace {
  const src = connector.iconUrl?.trim();
  if (src) return { kind: 'image', src };
  if (connector.provider === 'channel') {
    if (connector.platform === 'slack') return { kind: 'slack' };
    if (connector.platform === 'email') return { kind: 'glyph', glyph: 'email' };
  }
  return { kind: 'glyph', glyph: PROVIDER_GLYPH[connector.provider] ?? 'app' };
}
