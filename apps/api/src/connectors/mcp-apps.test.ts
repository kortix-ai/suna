import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config';
import { type ConnectorCatalogItem, createConnectorCatalog } from './connector-catalog';
import { fallbackIconSource } from './connector-icon';
import {
  MCP_APPS,
  availableMcpApps,
  kortixClientApplication,
  connectorsV2Items,
  kortixMcpCatalog,
  kortixOAuthClients,
  mcpAppForUrl,
} from './mcp-apps';
import { discoverProtectedResourceOAuth2, mcpSignInCheck } from './oauth2-resource-discovery';

const ICONS = join(import.meta.dir, '../../../web/public/connector-icons');
const GOOGLE = new Map([['google', { client_id: 'kortix-google', client_secret: 'kortix-google-secret' }]]);

describe('the Kortix MCP app catalogue', () => {
  test('every app has a unique slug and domain, an https endpoint, and an icon file exactly when it claims one', () => {
    expect(new Set(MCP_APPS.map((app) => app.slug)).size).toBe(MCP_APPS.length);
    expect(new Set(MCP_APPS.map((app) => app.domain)).size).toBe(MCP_APPS.length);
    for (const app of MCP_APPS) {
      expect(new URL(app.url).protocol).toBe('https:');
      expect(existsSync(join(ICONS, `${app.slug}.svg`))).toBe(app.icon);
      if (app.auth.kind === 'kortix_client') {
        for (const url of [app.auth.issuer, app.auth.authorizationUrl, app.auth.tokenUrl]) {
          expect(new URL(url).protocol).toBe('https:');
        }
      }
    }
    const listed = new Set(MCP_APPS.filter((app) => app.icon).map((app) => `${app.slug}.svg`));
    expect(readdirSync(ICONS).filter((file) => !listed.has(file))).toEqual([]);
  });

  test('an app on a Kortix client is listed only when that client is configured', () => {
    const none = availableMcpApps(new Map()).map((app) => app.slug);
    expect(none).toContain('linear');
    expect(none).not.toContain('gmail');
    const withGoogle = availableMcpApps(GOOGLE).map((app) => app.slug);
    expect(withGoogle).toContain('gmail');
    expect(withGoogle).not.toContain('github');
  });

  test('KORTIX_OAUTH_CLIENTS: malformed JSON and incomplete entries configure nothing', () => {
    expect(kortixOAuthClients('not json').size).toBe(0);
    const clients = kortixOAuthClients('{"google":{"client_id":"a","client_secret":"b"},"github":{"client_id":"only-id"}}');
    expect([...clients.keys()]).toEqual(['google']);
  });

  test('an endpoint matches exactly: case and a trailing slash do not matter, a query or another path does', () => {
    expect(mcpAppForUrl('https://MCP.linear.app/mcp/')?.slug).toBe('linear');
    expect(mcpAppForUrl('https://mcp.linear.app/mcp?x=1')).toBeNull();
    expect(mcpAppForUrl('https://mcp.linear.app/other')).toBeNull();
    expect(mcpAppForUrl('http://mcp.linear.app/mcp')).toBeNull();
  });

  test("Kortix's client is used only for a catalogue URL, with the catalogue's endpoints", () => {
    const application = kortixClientApplication('https://gmailmcp.googleapis.com/mcp/v1', GOOGLE);
    expect(application).toMatchObject({
      client_id: 'kortix-google',
      client_secret: 'kortix-google-secret',
      authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_url: 'https://oauth2.googleapis.com/token',
      authorization_params: { access_type: 'offline', prompt: 'consent' },
    });
    expect(application?.scopes).toContain('https://www.googleapis.com/auth/gmail.compose');
    expect(kortixClientApplication('https://evil.example/mcp', GOOGLE)).toBeNull();
    expect(kortixClientApplication('https://mcp.linear.app/mcp', GOOGLE)).toBeNull();
    expect(kortixClientApplication('https://gmailmcp.googleapis.com/mcp/v1', new Map())).toBeNull();
  });

  test('the catalogue serves Discover: list, sections and detail with the MCP surface', async () => {
    const catalog = v2Catalog();
    const page = await catalog.list({ q: 'linear' });
    expect(page.items[0]).toMatchObject({ id: 'kortix:linear', kind: 'mcp', mcpUrl: 'https://mcp.linear.app/mcp', icon: '/connector-icons/linear.svg', oneClick: true });
    const sections = await catalog.sections();
    expect(sections.popular[0]?.id).toBe('kortix:gmail');
    expect(sections.sections.length).toBeGreaterThan(0);
    const detail = await kortixMcpCatalog.detail('kortix:notion');
    expect(detail.variants).toEqual([
      expect.objectContaining({ kind: 'mcp', connector: { provider: 'mcp', url: 'https://mcp.notion.com/mcp', transport: 'http' } }),
    ]);
  });

  test('one card per app: a one-click MCP server, else the managed toolkit, else the API', async () => {
    const catalog = v2Catalog();
    const card = async (q: string) => (await catalog.list({ q })).items[0];
    // integrations.sh has a one-click server for Acme: it beats Acme's toolkit.
    expect(await card('acme')).toMatchObject({ id: 'acme-mcp', kind: 'mcp', oneClick: true });
    // Outlook's MCP server needs setup, so its managed toolkit is the card.
    expect(await card('outlook')).toMatchObject({ id: 'composio:outlook', kind: 'composio', domain: 'outlook.com', oneClick: true });
    // A Kortix app is the only record for its domain: Linear's toolkit is gone.
    expect((await catalog.list({ q: 'linear' })).items.map((item) => item.id)).toEqual(['kortix:linear']);
    // An API-only app lists, but not under the one-click filter.
    expect(await card('billing')).toMatchObject({ id: 'billing-openapi', kind: 'openapi' });
    const oneClick = (await catalog.list({ oneClick: true, limit: 96 })).items.map((item) => item.id);
    expect(oneClick).toContain('composio:outlook');
    expect(oneClick).toContain('acme-mcp');
    expect(oneClick).not.toContain('billing-openapi');
    expect(oneClick).not.toContain('outlook-mcp');
  });

  test('a source that is down drops out and the others still list', async () => {
    const items = await connectorsV2Items({
      apps: () => availableMcpApps(new Map()),
      index: async () => { throw new Error('integrations.sh is down'); },
      toolkits: async () => [toolkit('outlook', 'Outlook')],
    });
    expect(items.some((item) => item.id === 'kortix:linear')).toBe(true);
    expect(items.find((item) => item.kind === 'composio')).toMatchObject({ domain: 'outlook.composio' });
  });
});

const toolkit = (slug: string, name: string) => ({ slug, name, logo: null, description: null, categories: ['productivity'], isNoAuth: false, connected: false });
const record = (id: string, kind: ConnectorCatalogItem['kind'], name: string, domain: string, extra: Partial<ConnectorCatalogItem> = {}): ConnectorCatalogItem => ({
  id, kind, slug: id, name, description: null, url: null, icon: null, domain, categories: ['productivity'], feeds: ['claude'], popularity: null, ...extra,
});

/** The connectors_v2 catalogue over fixed sources: no network. */
function v2Catalog() {
  return createConnectorCatalog({
    source: {
      items: () =>
        connectorsV2Items({
          apps: () => availableMcpApps(GOOGLE),
          index: async () => [
            record('acme-mcp', 'mcp', 'Acme', 'acme.com', { mcpUrl: 'https://mcp.acme.com/mcp', oneClick: true }),
            record('outlook-mcp', 'mcp', 'Outlook', 'outlook.com', { mcpUrl: 'https://mcp.outlook.example/mcp' }),
            record('billing-openapi', 'openapi', 'Billing', 'billing.dev'),
            record('linear-openapi', 'openapi', 'Linear', 'linear.app'),
          ],
          toolkits: async () => [toolkit('acme', 'Acme'), toolkit('outlook', 'Outlook'), toolkit('linear', 'Linear')],
        }),
      surfaces: () => [],
    },
  });
}

describe('sign-in for an app on a Kortix client', () => {
  test('discovery comes from the catalogue, without probing the server, and is one click', async () => {
    const previous = config.KORTIX_OAUTH_CLIENTS;
    (config as { KORTIX_OAUTH_CLIENTS: string }).KORTIX_OAUTH_CLIENTS = JSON.stringify({ google: { client_id: 'kortix-google', client_secret: 's' } });
    try {
      const discovery = await discoverProtectedResourceOAuth2(
        { resourceUrl: 'https://calendarmcp.googleapis.com/mcp/v1', provider: 'mcp' },
        { fetchImpl: async () => { throw new Error('the server must not be probed'); } },
      );
      expect(discovery).toMatchObject({ requires_authorization: true, kortix_client: true, authorization_server: 'https://accounts.google.com' });
      expect(JSON.stringify(discovery)).not.toContain('kortix-google');
      expect(mcpSignInCheck(discovery)).toEqual({ requires_sign_in: true, one_click: true });
    } finally {
      (config as { KORTIX_OAUTH_CLIENTS: string }).KORTIX_OAUTH_CLIENTS = previous;
    }
  });

  test('a connector on a catalogue app shows the catalogue icon', () => {
    expect(fallbackIconSource('mcp', { url: 'https://mcp.figma.com/mcp' })).toEqual({ kind: 'kortix', icon: '/connector-icons/figma.svg' });
    expect(fallbackIconSource('mcp', { url: 'https://mcp.granola.ai/mcp' })).toEqual({ kind: 'catalog', host: 'mcp.granola.ai' });
  });
});
