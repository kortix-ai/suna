import { describe, expect, test } from 'bun:test';
import {
  catalogIconForHost,
  connectorEndpointHost,
  resolveConnectorIcons,
  type ConnectorIconSources,
} from './connector-icon';

const ICONS = new Map([
  ['stripe.com', 'https://icons.test/stripe.com'],
  ['linear.app', 'https://icons.test/linear.app'],
  ['googleapis.com', 'https://icons.test/googleapis.com'],
  ['amazonaws.com', 'https://icons.test/amazonaws.com'],
]);

function sources(overrides: Partial<ConnectorIconSources> = {}): ConnectorIconSources {
  return {
    composioLogo: async (toolkit) => `https://logos.test/${toolkit}`,
    catalogIcons: async () => ICONS,
    ...overrides,
  };
}

describe('connectorEndpointHost', () => {
  test('reads the host of the URL each direct provider calls', () => {
    expect(connectorEndpointHost('mcp', { url: 'https://mcp.linear.app/sse' })).toBe(
      'mcp.linear.app',
    );
    expect(connectorEndpointHost('openapi', { server: 'https://api.stripe.com/v1' })).toBe(
      'api.stripe.com',
    );
    expect(connectorEndpointHost('http', { baseUrl: 'https://API.Stripe.com' })).toBe(
      'api.stripe.com',
    );
    expect(
      connectorEndpointHost('graphql', {
        endpoint: 'https://api.linear.app/graphql',
      }),
    ).toBe('api.linear.app');
  });

  test('never reads the spec document host, which is usually a code host', () => {
    expect(
      connectorEndpointHost('openapi', {
        spec: 'https://raw.githubusercontent.com/example/openapi.json',
        server: null,
      }),
    ).toBeNull();
    expect(
      connectorEndpointHost('postman', {
        spec: 'https://github.com/example/c',
      }),
    ).toBeNull();
  });

  test('answers null for managed, channel and computer connectors and for bad URLs', () => {
    expect(connectorEndpointHost('composio', { app: 'gmail' })).toBeNull();
    expect(connectorEndpointHost('channel', { baseUrl: 'https://slack.com/api' })).toBeNull();
    expect(connectorEndpointHost('computer', {})).toBeNull();
    expect(connectorEndpointHost('mcp', { url: 'not a url' })).toBeNull();
    expect(connectorEndpointHost('mcp', null)).toBeNull();
  });
});

describe('catalogIconForHost', () => {
  test('matches the exact host, then its parent domain', () => {
    expect(catalogIconForHost('stripe.com', ICONS)).toBe('https://icons.test/stripe.com');
    expect(catalogIconForHost('api.stripe.com', ICONS)).toBe('https://icons.test/stripe.com');
    expect(catalogIconForHost('mcp.linear.app', ICONS)).toBe('https://icons.test/linear.app');
  });

  test('strips at most one label so a deep host never borrows a platform logo', () => {
    expect(catalogIconForHost('api.eu.stripe.com', ICONS)).toBeNull();
    expect(catalogIconForHost('abc123.execute-api.us-east-1.amazonaws.com', ICONS)).toBeNull();
  });

  test('never matches a bare suffix, an IP address or a single-label host', () => {
    expect(catalogIconForHost('localhost', ICONS)).toBeNull();
    expect(catalogIconForHost('10.0.0.5', ICONS)).toBeNull();
    expect(catalogIconForHost('internal.example', ICONS)).toBeNull();
    expect(catalogIconForHost('[::1]', ICONS)).toBeNull();
  });
});

describe('resolveConnectorIcons', () => {
  test('resolves a Composio app from its toolkit and a direct provider from the catalogue', async () => {
    const icons = await resolveConnectorIcons(
      [
        { slug: 'gmail', provider: 'composio', config: { app: 'gmail' } },
        {
          slug: 'stripe',
          provider: 'openapi',
          config: { server: 'https://api.stripe.com' },
        },
        {
          slug: 'private',
          provider: 'http',
          config: { baseUrl: 'https://api.internal.test' },
        },
        { slug: 'slack', provider: 'channel', config: { platform: 'slack' } },
      ],
      sources(),
    );

    expect(Object.fromEntries(icons)).toEqual({
      gmail: 'https://logos.test/gmail',
      stripe: 'https://icons.test/stripe.com',
    });
  });

  test('never asks a source that no connector needs', async () => {
    let composioCalls = 0;
    let catalogCalls = 0;
    const icons = await resolveConnectorIcons(
      [{ slug: 'slack', provider: 'channel', config: {} }],
      sources({
        composioLogo: async () => {
          composioCalls += 1;
          return null;
        },
        catalogIcons: async () => {
          catalogCalls += 1;
          return ICONS;
        },
      }),
    );

    expect(icons.size).toBe(0);
    expect(composioCalls).toBe(0);
    expect(catalogCalls).toBe(0);
  });

  test('a failing or slow source costs the list its logos, never an error or the budget', async () => {
    const started = Date.now();
    const icons = await resolveConnectorIcons(
      [
        { slug: 'gmail', provider: 'composio', config: { app: 'gmail' } },
        {
          slug: 'stripe',
          provider: 'openapi',
          config: { server: 'https://api.stripe.com' },
        },
      ],
      sources({
        composioLogo: async () => {
          throw new Error('provider down');
        },
        catalogIcons: () => new Promise(() => {}),
      }),
      { budgetMs: 50 },
    );

    expect(icons.size).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
