import { describe, expect, test } from 'bun:test';

import { connectorDocLinks } from './connector-doc-links';

describe('connectorDocLinks', () => {
  test('every connector gets the Kortix guide first, and it is internal', () => {
    const links = connectorDocLinks({ provider: 'openapi', slug: 'acme', name: 'Acme' });
    expect(links[0]).toEqual({
      label: 'Kortix docs',
      href: '/docs/connect/connectors',
      external: false,
    });
  });

  test('managed OAuth connectors deep-link to the OAuth walkthrough anchor', () => {
    for (const provider of ['pipedream', 'composio'] as const) {
      const [kortix] = connectorDocLinks({ provider, slug: 'x', name: 'X' });
      expect(kortix.href).toBe('/docs/connect/connectors#connect-with-oauth');
    }
  });

  test('an MCP connector links the MCP section anchor and the MCP spec', () => {
    const links = connectorDocLinks({ provider: 'mcp', slug: 'attio', name: 'Attio' });
    expect(links[0].href).toBe(
      '/docs/connect/connectors#connect-an-mcp-server-that-uses-oauth-21',
    );
    const mcp = links.find((l) => l.label === 'MCP docs');
    expect(mcp?.href).toBe('https://modelcontextprotocol.io/docs');
    expect(mcp?.external).toBe(true);
  });

  test('channel and computer connectors go to their own guides', () => {
    expect(connectorDocLinks({ provider: 'channel', slug: 's', name: 'Slack' })[0].href).toBe(
      '/docs/connect/slack',
    );
    expect(connectorDocLinks({ provider: 'computer', slug: 'c', name: 'Computers' })[0].href).toBe(
      '/docs/connect/computers',
    );
  });

  test('a known app resolves its developer docs by slug OR by display name', () => {
    const bySlug = connectorDocLinks({ provider: 'mcp', slug: 'linear', name: 'Renamed' });
    expect(bySlug.find((l) => l.label === 'Renamed API docs')?.href).toBe(
      'https://linear.app/developers',
    );
    // The slug is custom but the name still identifies the app.
    const byName = connectorDocLinks({ provider: 'openapi', slug: 'crm-main', name: 'HubSpot' });
    expect(byName.find((l) => l.label === 'HubSpot API docs')?.href).toBe(
      'https://developers.hubspot.com/docs/api/overview',
    );
  });

  test('name folding tolerates spacing and case — "Google Sheets" hits googlesheets', () => {
    const links = connectorDocLinks({
      provider: 'pipedream',
      slug: 'sheets-main',
      name: 'Google Sheets',
    });
    expect(links.find((l) => l.label === 'Google Sheets API docs')?.href).toBe(
      'https://developers.google.com/workspace/sheets',
    );
  });

  test('an unknown app gets no provider link and no dead guess', () => {
    const links = connectorDocLinks({
      provider: 'http',
      slug: 'internal-billing',
      name: 'Internal Billing',
    });
    expect(links).toHaveLength(1);
  });

  test('a website link rides along only when curated', () => {
    const links = connectorDocLinks({ provider: 'mcp', slug: 'attio', name: 'Attio' });
    expect(links.find((l) => l.label === 'Website')?.href).toBe('https://attio.com');
  });

  test('every external link is https and every internal one is a /docs path', () => {
    const samples = [
      connectorDocLinks({ provider: 'mcp', slug: 'github', name: 'GitHub' }),
      connectorDocLinks({ provider: 'pipedream', slug: 'slack', name: 'Slack' }),
      connectorDocLinks({ provider: 'channel', slug: 'ch', name: 'Ch' }),
    ].flat();
    for (const link of samples) {
      if (link.external) expect(link.href).toStartWith('https://');
      else expect(link.href).toStartWith('/docs/');
    }
  });
});
