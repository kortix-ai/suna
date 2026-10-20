import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DiscoverConnectorTemplate } from '@kortix/sdk';
import { buildDiscoverConnectorDraft } from './connector-connection-form';
import { DiscoverCatalogue } from './discover-catalogue';
import { discoverInstallTarget } from '../../capabilities/connectors/install/install';

const connection = { slug: 'synthetic-abc123', name: '  Synthetic account  ' };
const templates: DiscoverConnectorTemplate[] = [
  { provider: 'mcp', url: 'https://example.test/mcp', transport: 'http' },
  { provider: 'openapi', spec: 'https://example.test/spec.json', endpoint: 'https://example.test', auth: { type: 'custom', in: 'header', name: 'X-Key', prefix: 'Bearer' } },
  { provider: 'openapi', spec: 'https://example.test/spec.json', auth: { type: 'none', in: 'header', name: '', prefix: '' } },
];

test('renders cached catalogue pages in order with searchable input', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['connect-status'], { configured: true });
  client.setQueryData(['discover-pipedream-oauth', 'synthetic-project', ''], { pages: [{ apps: [
    { slug: 'oauth-synthetic', name: 'OAuth synthetic', authType: 'oauth' },
    { slug: 'slack', name: 'Excluded Slack', authType: 'oauth' },
    { slug: 'slack_v2', name: 'Excluded Slack v2', authType: 'oauth' },
    { slug: 'key-synthetic', name: 'Excluded key app', authType: 'keys' },
  ], hasMore: false }], pageParams: [undefined] });
  client.setQueryData(['discover-connectors', 'synthetic-project', ''], {
    pages: [
      { items: [{ id: 'alpha', name: 'Alpha synthetic', description: 'First description' }], hasMore: true, nextCursor: 'next' },
      { items: [{ id: 'beta', name: 'Beta synthetic', description: 'Second description' }], hasMore: false },
    ], pageParams: [undefined, 'next'],
  });
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><DiscoverCatalogue projectId="synthetic-project" existingSlugs={[]} onAdded={() => {}} /></QueryClientProvider>);
  expect(html).toContain('First description');
  expect(html).toContain('Second description');
  expect(html.indexOf('Alpha synthetic')).toBeLessThan(html.indexOf('Beta synthetic'));
  expect(html).toContain('OAuth synthetic');
  expect(html.indexOf('Beta synthetic')).toBeLessThan(html.indexOf('OAuth synthetic'));
  expect(html).not.toContain('Excluded');
  expect(html).toContain('<input');
  expect(html.match(/type="button"/g)?.length).toBeGreaterThanOrEqual(2);
  client.clear();
});

test('install drafts preserve optional template fields, omit empty auth fields and trim only name', () => {
  const drafts = templates.map((template) => discoverInstallTarget('Synthetic', { id: 'surface', kind: 'mcp', name: 'Synthetic', template }).buildDraft(connection));
  expect(drafts).toEqual([
    { ...connection, name: 'Synthetic account', provider: 'mcp', url: 'https://example.test/mcp', transport: 'http', create_only: true },
    { ...connection, name: 'Synthetic account', provider: 'openapi', spec: 'https://example.test/spec.json', endpoint: 'https://example.test', auth: { type: 'custom', in: 'header', name: 'X-Key', prefix: 'Bearer' }, create_only: true },
    { ...connection, name: 'Synthetic account', provider: 'openapi', spec: 'https://example.test/spec.json', auth: { type: 'none', in: 'header' }, create_only: true },
  ]);
});

test('Discover and Install use identical create-only drafts for every optional auth shape', () => {
  for (const template of templates) {
    const discover = buildDiscoverConnectorDraft(template, connection);
    const install = discoverInstallTarget('Synthetic', { id: 'surface', kind: 'mcp', name: 'Synthetic', template }).buildDraft(connection);
    expect(discover).toEqual(install);
    expect(discover.create_only).toBe(true);
    expect(discover.name).toBe('Synthetic account');
  }
});
