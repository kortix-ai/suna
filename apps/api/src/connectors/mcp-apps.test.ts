import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config';
import { type ConnectorCatalogItem, type ConnectorSurfaceVariant, createConnectorCatalog } from './connector-catalog';
import { fallbackIconSource } from './connector-icon';
import {
  KORTIX_APPS,
  MCP_APPS,
  availableMcpApps,
  kortixClientApplication,
  catalogDegraded,
  composioCatalogItem,
  connectorsV2Items,
  connectorsV2Surfaces,
  v2AppKey,
  kortixOAuthClients,
  mcpAppForUrl,
} from './mcp-apps';
import { createStoredDelegatedCredential, resolveStoredDelegatedCredential } from './oauth2-delegated';
import { buildOAuth2AuthorizationRequest, exchangeOAuth2AuthorizationCode } from './oauth2-lifecycle';
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
    const listed = new Set([
      ...MCP_APPS.filter((app) => app.icon).map((app) => `${app.slug}.svg`),
      ...KORTIX_APPS.flatMap((entry) => (entry.icon ? [entry.icon.split('/').pop()!] : [])),
    ]);
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
    // The app's ways, with no network: the Kortix app's own server leads.
    const ways = await connectorsV2Surfaces('notion.so', { items: async () => [], surfaces: async () => [] });
    expect(ways).toEqual([
      expect.objectContaining({ kind: 'mcp', recommended: true, oneClick: true, connector: { provider: 'mcp', url: 'https://mcp.notion.com/mcp', transport: 'http' } }),
    ]);
  });

  test('one card per app: a one-click MCP server, else the managed toolkit, else the API', async () => {
    const catalog = v2Catalog();
    const card = async (q: string) => (await catalog.list({ q })).items[0];
    // integrations.sh has a one-click server for Acme: it beats Acme's toolkit.
    expect(await card('acme')).toMatchObject({ id: 'acme-mcp', kind: 'mcp', oneClick: true });
    // Outlook's MCP server needs setup, so its managed toolkit is the card.
    expect(await card('outlook')).toMatchObject({ id: 'composio:outlook', kind: 'composio', domain: 'outlook.com', oneClick: true });
    // A Kortix app is the only record for its app, by domain and by name:
    // Linear's toolkit and Notion's registry entry on notion.com are gone.
    expect((await catalog.list({ q: 'linear' })).items.map((item) => item.id)).toEqual(['kortix:linear']);
    expect((await catalog.list({ q: 'notion' })).items.map((item) => item.id)).toEqual(['kortix:notion']);
    // A worse surface of an app still answers a search for it.
    expect((await catalog.list({ q: 'graph mail' })).items.map((item) => item.id)).toEqual(['graph-mail-openapi']);
    // Browse sections keep a domain's first record: the toolkit, not Outlook's setup-only server.
    const productivity = (await catalog.sections({ perCategory: 24 })).sections.find((section) => section.key === 'productivity');
    expect(productivity?.items.map((item) => item.id)).toContain('composio:outlook');
    expect(productivity?.items.map((item) => item.id)).not.toContain('outlook-mcp');
    // An API-only app lists, but not under the one-click filter.
    expect(await card('billing')).toMatchObject({ id: 'billing-openapi', kind: 'openapi' });
    const oneClick = (await catalog.list({ oneClick: true, limit: 96 })).items.map((item) => item.id);
    expect(oneClick).toContain('composio:outlook');
    expect(oneClick).toContain('acme-mcp');
    expect(oneClick).not.toContain('billing-openapi');
    expect(oneClick).not.toContain('outlook-mcp');
    // Browse order: Kortix's apps, then popular registry apps and managed apps
    // taking turns, then the rest.
    const browse = (await catalog.list({ limit: 96 })).items.map((item) => item.id);
    // Kortix's own block: what it built and its MCP apps.
    const firstOther = browse.findIndex((id) => !id.startsWith('kortix:') && !id.startsWith('native:'));
    // Managed apps keep Composio's usage order, whatever their domain's first record.
    expect(browse.slice(firstOther, firstOther + 3)).toEqual(['acme-mcp', 'composio:zeta', 'composio:outlook']);
    expect(browse.indexOf('composio:outlook')).toBeLessThan(browse.indexOf('billing-openapi'));
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

describe('the ways to connect one app (catalogue detail)', () => {
  const variant = (id: string, kind: ConnectorSurfaceVariant['kind'], url: string | null, connector: boolean) =>
    ({ id, kind, name: id, url, docs: null, description: null, transports: [], requiresAuth: true, command: null,
       connector: connector ? { provider: kind === 'graphql' ? 'graphql' : kind === 'openapi' ? 'openapi' : 'mcp', url: url ?? undefined } : null }) as ConnectorSurfaceVariant;

  test('every way of the app, best first: Kortix MCP app, registry API, managed toolkit; the duplicate server once', async () => {
    const items = async () => [
      { ...record('kortix:stripe', 'mcp', 'Stripe', 'stripe.com', { feeds: ['kortix'], oneClick: true }) },
      record('stripe-openapi', 'openapi', 'Stripe', 'stripe.com'),
      composioCatalogItem(toolkit('stripe', 'Stripe'), 'stripe.com'),
    ];
    const surfaces = async (domain: string) =>
      domain === 'stripe.com'
        ? [variant('registry-mcp', 'mcp', 'https://mcp.stripe.com', true), variant('stripe-api', 'openapi', null, true), variant('stripe-http', 'http', null, false)]
        : [];
    const ways = await connectorsV2Surfaces('stripe.com', { items, surfaces });
    expect(ways.map((way) => [way.id, way.kind, way.oneClick === true, way.recommended === true])).toEqual([
      ['kortix:stripe:mcp', 'mcp', true, true],
      ['composio:stripe', 'composio', true, false],
      ['stripe-api', 'openapi', false, false],
      ['stripe-http', 'http', false, false],
    ]);
  });

  test('"Bitbucket API" in the registry and Bitbucket in Composio are one app', async () => {
    const items = await connectorsV2Items({
      apps: () => [],
      index: async () => [record('openapi/bitbucket-org', 'openapi', 'Bitbucket API', 'bitbucket.org')],
      toolkits: async () => [toolkit('bitbucket', 'Bitbucket')],
    });
    expect(items.find((item) => item.kind === 'composio')?.domain).toBe('bitbucket.org');
    expect(v2AppKey('Stripe REST API')).toBe('stripe');
    expect(v2AppKey('API')).toBe('');
  });

  test('YouTube is one app: the toolkit whose name matches no record joins the registry\'s <slug>.com', async () => {
    const catalog = createConnectorCatalog({
      source: {
        items: () =>
          connectorsV2Items({
            apps: () => [],
            index: async () => [
              record('curated/google-youtube-data', 'openapi', 'YouTube Data', 'youtube.com'),
              record('openapi/acme', 'openapi', 'Acme Platform', 'acme.com'),
            ],
            toolkits: async () => [
              toolkit('youtube', 'YouTube'),
              toolkit('youtube_transcript', 'YouTube Transcript'),
              toolkit('zeta', 'Zeta'),
            ],
          }),
        surfaces: async () => [],
      },
    });
    const ids = async (q: string) => (await catalog.list({ q })).items.map((item) => [item.id, item.domain]);
    // One YouTube card, and it is the one-click toolkit, not the API that asks for a key.
    expect(await ids('youtube')).toEqual([
      ['composio:youtube', 'youtube.com'],
      ['composio:youtube_transcript', 'youtube_transcript.composio'],
    ]);
    // No registry domain for the slug: the toolkit keeps its own card.
    expect(await ids('zeta')).toEqual([['composio:zeta', 'zeta.composio']]);
    // The API stays one more way on the app page, after the toolkit.
    const ways = await connectorsV2Surfaces('youtube.com', {
      items: () =>
        connectorsV2Items({
          apps: () => [],
          index: async () => [record('curated/google-youtube-data', 'openapi', 'YouTube Data', 'youtube.com')],
          toolkits: async () => [toolkit('youtube', 'YouTube')],
        }),
      surfaces: async () => [variant('youtube-data-api', 'openapi', null, true)],
    });
    expect(ways.map((way) => [way.id, way.recommended === true])).toEqual([
      ['composio:youtube', true],
      ['youtube-data-api', false],
    ]);
  });

  test('an app with no one-click server recommends its managed toolkit; a registry record on another domain still counts', async () => {
    const items = async () => [
      { ...record('jira-openapi', 'openapi', 'Bitbucket', 'bitbucket.org') },
      composioCatalogItem(toolkit('bitbucket', 'Bitbucket'), 'bitbucket.org'),
    ];
    const surfaces = async () => [variant('bb-mcp', 'mcp', 'https://mcp.example/bb', true), variant('bb-api', 'openapi', null, true)];
    const ways = await connectorsV2Surfaces('bitbucket.org', { items, surfaces });
    expect(ways.map((way) => [way.kind, way.recommended === true])).toEqual([
      ['composio', true],
      ['mcp', false],
      ['openapi', false],
    ]);
  });
});

describe('What Kortix built, in the catalogue', () => {
  test('each is a one-click Kortix card that leads its app, ahead of the app\'s MCP server and Composio', async () => {
    const items = await connectorsV2Items({
      apps: () => [],
      index: async () => [record('curated/slack-com-mcp', 'mcp', 'Slack', 'slack.com', { mcpUrl: 'https://mcp.slack.com/mcp' }), record('openapi/telegram-org', 'openapi', 'Telegram', 'telegram.org')],
      toolkits: async () => [toolkit('telegram', 'Telegram')],
    });
    const kortix = items.filter((item) => item.kind === 'kortix').map((item) => item.id);
    expect(kortix).toEqual(['native:slack', 'native:teams', 'native:email', 'native:telegram', 'native:discord', 'native:computer']);
    const catalog = createConnectorCatalog({ source: { items: async () => items, surfaces: () => [] } });
    expect((await catalog.list({ q: 'slack' })).items[0]?.id).toBe('native:slack');
    expect((await catalog.list({ q: 'telegram' })).items.map((item) => item.id)).toEqual(['native:telegram']);
    expect((await catalog.list({ kinds: ['kortix'], limit: 10 })).items).toHaveLength(6);
    expect((await catalog.list({ q: 'computer' })).items[0]).toMatchObject({ id: 'native:computer', kind: 'kortix', kortix: { app: 'computer' } });
    // Links from before the rename (`channel:<platform>`) still open the app.
    expect((await catalog.detail('channel:email')).item.id).toBe('native:email');
    expect((await catalog.detail('native:email')).item.id).toBe('native:email');
    await expect(catalog.detail('channel:nope')).rejects.toThrow('Connector not found');
    const ways = await connectorsV2Surfaces('telegram.org', { items: async () => items, surfaces: async () => [] });
    expect(ways.map((way) => [way.kind, way.recommended === true])).toEqual([['kortix', true], ['composio', false]]);
  });
});

describe('the catalogue type filter', () => {
  test('kinds keeps the apps that connect that way, each by its record of that kind', async () => {
    const catalog = v2Catalog();
    const ids = async (kinds: ConnectorCatalogItem['kind'][]) => (await catalog.list({ kinds, limit: 96 })).items.map((item) => item.id);
    expect(await ids(['composio'])).toEqual(expect.arrayContaining(['composio:outlook', 'composio:zeta']));
    expect((await ids(['composio'])).every((id) => id.startsWith('composio:'))).toBe(true);
    expect(await ids(['openapi'])).toEqual(expect.arrayContaining(['billing-openapi', 'graph-mail-openapi', 'linear-openapi']));
    expect((await ids(['mcp', 'openapi'])).some((id) => id.startsWith('composio:'))).toBe(false);
  });
});

const toolkit = (slug: string, name: string) => ({ slug, name, logo: null, description: null, categories: ['productivity'], isNoAuth: false, connected: false });
const record = (id: string, kind: ConnectorCatalogItem['kind'], name: string, domain: string, extra: Partial<ConnectorCatalogItem> = {}): ConnectorCatalogItem => ({
  id, kind, slug: id, name, description: null, url: null, icon: null, domain, categories: ['productivity'], feeds: ['claude'], popularity: null, ...extra,
});

/** The Kortix catalogue over fixed sources: no network. */
function v2Catalog() {
  return createConnectorCatalog({
    source: {
      items: () =>
        connectorsV2Items({
          apps: () => availableMcpApps(GOOGLE),
          index: async () => [
            record('acme-mcp', 'mcp', 'Acme', 'acme.com', { mcpUrl: 'https://mcp.acme.com/mcp', oneClick: true, popularity: 50 }),
            record('outlook-mcp', 'mcp', 'Outlook', 'outlook.com', { mcpUrl: 'https://mcp.outlook.example/mcp' }),
            record('billing-openapi', 'openapi', 'Billing', 'billing.dev'),
            record('graph-files-mcp', 'mcp', 'Graph Files', 'graph.example', { mcpUrl: 'https://graph.example/mcp', oneClick: true }),
            record('graph-mail-openapi', 'openapi', 'Graph Mail', 'graph.example'),
            record('linear-openapi', 'openapi', 'Linear', 'linear.app'),
            record('notion-com-mcp', 'mcp', 'Notion', 'notion.com', { mcpUrl: 'https://mcp.notion.com/mcp', oneClick: true }),
          ],
          toolkits: async () => [toolkit('zeta', 'Zeta'), toolkit('acme', 'Acme'), toolkit('outlook', 'Outlook'), toolkit('linear', 'Linear')],
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

describe('an app the project cannot use yet', () => {
  test('`exclude` leaves it out before counting: list totals, section totals and category facets agree', async () => {
    const catalog = v2Catalog();
    const all = await catalog.list({ limit: 96 });
    const hidden = new Set(['native:email']);
    expect(all.items.some((item) => item.id === 'native:email')).toBe(true);
    const kept = await catalog.list({ limit: 96, exclude: hidden });
    expect(kept.items.some((item) => item.id === 'native:email')).toBe(false);
    expect(kept.total).toBe(all.total - 1);
    const sections = (await catalog.sections({ exclude: hidden })) as {
      sections: Array<{ key: string; total: number }>;
      categories: Array<{ key: string; count: number }>;
    };
    for (const section of sections.sections) {
      expect(sections.categories.find((c) => c.key === section.key)?.count).toBe(section.total);
      const page = await catalog.list({ category: section.key, exclude: hidden });
      expect(page.total).toBe(section.total);
    }
  });
});

describe('a catalogue source that is down', () => {
  test('drops out of the list and is named in catalogDegraded until it answers again', async () => {
    const items = await connectorsV2Items({
      apps: () => [],
      index: async () => [],
      toolkits: async () => {
        throw new Error('composio 503');
      },
    });
    expect(items.length).toBe(KORTIX_APPS.length);
    expect(catalogDegraded()).toEqual(['composio']);
    await connectorsV2Items({ apps: () => [], index: async () => [], toolkits: async () => [] });
    expect(catalogDegraded()).toEqual([]);
  });
});

describe('X: one-click sign-in with Kortix’s own X client', () => {
  const X_MCP = 'https://api.x.com/mcp';
  const X_CLIENT = new Map([['x', { client_id: 'kortix-x', client_secret: 'kortix-x-secret' }]]);
  const CALLBACK = 'https://api.kortix.test/v1/connectors/oauth2/callback';
  // What api.x.com published on 2026-11-04: RFC 9728 + RFC 8414, no registration endpoint.
  const xServer = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url === X_MCP) {
      return new Response('{}', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://api.x.com/.well-known/oauth-protected-resource"' } });
    }
    if (url.startsWith('https://api.x.com/.well-known/oauth-protected-resource')) {
      return Response.json({ resource: X_MCP, authorization_servers: ['https://api.x.com'], scopes_supported: ['tweet.read', 'offline.access'] });
    }
    if (url.startsWith('https://api.x.com/.well-known/')) {
      return Response.json({
        issuer: 'https://api.x.com',
        authorization_endpoint: 'https://x.com/i/oauth2/authorize',
        token_endpoint: 'https://api.x.com/2/oauth2/token',
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
      });
    }
    return new Response('not found', { status: 404 });
  };
  async function withClients<T>(clients: string, run: () => Promise<T>): Promise<T> {
    const previous = config.KORTIX_OAUTH_CLIENTS;
    (config as { KORTIX_OAUTH_CLIENTS: string }).KORTIX_OAUTH_CLIENTS = clients;
    try {
      return await run();
    } finally {
      (config as { KORTIX_OAUTH_CLIENTS: string }).KORTIX_OAUTH_CLIENTS = previous;
    }
  }

  test('without an X client the server is not one click: it publishes endpoints but no registration (the 404 cause)', async () => {
    const discovery = await withClients('', () => discoverProtectedResourceOAuth2({ resourceUrl: X_MCP, provider: 'mcp' }, { fetchImpl: xServer }));
    expect(discovery.metadata?.token_url).toBe('https://api.x.com/2/oauth2/token');
    expect(discovery.registration_endpoint).toBeUndefined();
    expect(discovery.kortix_client).toBeUndefined();
    expect(mcpSignInCheck(discovery)).toEqual({ requires_sign_in: true, one_click: false });
    expect(availableMcpApps(new Map()).map((app) => app.slug)).not.toContain('x');
  });

  test('with an X client the sign-in is one click, from the catalogue, without probing the server', async () => {
    const discovery = await withClients(JSON.stringify({ x: { client_id: 'kortix-x', client_secret: 'kortix-x-secret' } }), () =>
      discoverProtectedResourceOAuth2({ resourceUrl: X_MCP, provider: 'mcp' }, { fetchImpl: async () => { throw new Error('the server must not be probed'); } }),
    );
    expect(discovery).toMatchObject({ kortix_client: true, authorization_server: 'https://api.x.com', scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'] });
    expect(JSON.stringify(discovery)).not.toContain('kortix-x-secret');
    expect(mcpSignInCheck(discovery)).toEqual({ requires_sign_in: true, one_click: true });
    expect(availableMcpApps(X_CLIENT).map((app) => app.slug)).toContain('x');
  });

  test('authorize, code exchange, stored credential and refresh follow X’s confidential-client contract', async () => {
    const application = kortixClientApplication(X_MCP, X_CLIENT);
    expect(application).toMatchObject({ client_id: 'kortix-x', token_endpoint_auth_method: 'client_secret_basic', token_url: 'https://api.x.com/2/oauth2/token' });
    if (!application) throw new Error('no X application');

    const started = buildOAuth2AuthorizationRequest(application, { callbackUrl: CALLBACK });
    const authorize = new URL(started.authorizationUrl);
    expect(authorize.origin + authorize.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(authorize.searchParams.get('scope')).toBe('tweet.read tweet.write users.read offline.access');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(started.authorizationUrl).not.toContain('kortix-x-secret');

    const requests: Array<{ url: string; auth: string | null; body: URLSearchParams }> = [];
    let issued = 0;
    const tokenEndpoint = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(input), auth: new Headers(init?.headers).get('authorization'), body: new URLSearchParams(String(init?.body)) });
      issued += 1;
      return Response.json({ token_type: 'bearer', expires_in: 7200, access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, scope: 'tweet.read tweet.write users.read offline.access' });
    };
    const t0 = 1_800_000_000_000;
    const token = await exchangeOAuth2AuthorizationCode(application, { code: 'code-1', callbackUrl: CALLBACK, pkceVerifier: started.pkceVerifier }, { fetchImpl: tokenEndpoint, now: () => t0 });
    expect(token).toMatchObject({ access_token: 'access-1', refresh_token: 'refresh-1', expires_at: t0 + 7_200_000 });
    const basic = `Basic ${Buffer.from('kortix-x:kortix-x-secret').toString('base64')}`;
    expect(requests[0]).toMatchObject({ url: 'https://api.x.com/2/oauth2/token', auth: basic });
    expect(Object.fromEntries(requests[0]?.body ?? [])).toEqual({ grant_type: 'authorization_code', code: 'code-1', redirect_uri: CALLBACK, code_verifier: started.pkceVerifier });

    const stored = createStoredDelegatedCredential(application, token);
    // Still valid: no token request.
    expect(await resolveStoredDelegatedCredential(stored, { fetchImpl: tokenEndpoint, now: () => t0 + 60 * 60_000 })).toEqual({ accessToken: 'access-1', updatedValue: null });
    expect(requests).toHaveLength(1);
    // Inside the last minute of the 2 h lifetime: refresh, and keep X's rotated refresh token.
    const refreshed = await resolveStoredDelegatedCredential(stored, { fetchImpl: tokenEndpoint, now: () => t0 + 7_150_000 });
    expect(refreshed.accessToken).toBe('access-2');
    expect(requests[1]).toMatchObject({ url: 'https://api.x.com/2/oauth2/token', auth: basic });
    expect(requests[1]?.body.get('grant_type')).toBe('refresh_token');
    expect(requests[1]?.body.get('refresh_token')).toBe('refresh-1');
    expect(requests[1]?.body.has('client_secret')).toBe(false);
    expect(JSON.parse(refreshed.updatedValue ?? '{}').token.refresh_token).toBe('refresh-2');
  });
});
