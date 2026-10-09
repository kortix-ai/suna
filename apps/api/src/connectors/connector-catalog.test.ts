import { describe, expect, test } from 'bun:test';

import { createConnectorCatalog } from './connector-catalog';

const item = (id: string, kind: string, name: string, domain: string, description = '') => ({
  id,
  kind,
  slug: id,
  name,
  domain,
  description,
  url: null,
  icon: `https://icons.example.test/${domain}.png`,
  categories: [],
  feeds: [],
  popularity: null,
});

const INDEX = [
  item('autumn-mcp', 'mcp', 'useautumn.com', 'useautumn.com', 'Billing on top of Stripe'),
  item('stripe-cli', 'cli', 'Stripe', 'stripe.com'),
  item('autumn-api', 'openapi', 'useautumn.com', 'useautumn.com', 'Billing on top of Stripe'),
  item('stripe-api', 'openapi', 'Stripe', 'stripe.com'),
  item('stripe-mcp', 'mcp', 'Stripe', 'stripe.com'),
  item('stripe-sync', 'mcp', 'Stripe Sync', 'stripesync.example', 'Mirror Stripe data'),
];

function catalog() {
  return createConnectorCatalog({
    fetch: (async () =>
      new Response(JSON.stringify({ data: INDEX }), {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
  });
}

describe('connector catalogue search', () => {
  test('returns one card per app, preferring its MCP surface', async () => {
    const page = await catalog().list({ q: 'stripe' });
    const domains = page.items.map((entry) => entry.domain);
    expect(new Set(domains).size).toBe(domains.length);
    expect(page.items.find((entry) => entry.domain === 'stripe.com')?.kind).toBe('mcp');
    expect(page.total).toBe(3);
  });

  test('ranks an exact name match first, then names that start with the query', async () => {
    const page = await catalog().list({ q: 'stripe' });
    expect(page.items.map((entry) => entry.name)).toEqual([
      'Stripe',
      'Stripe Sync',
      'useautumn.com',
    ]);
  });

  test('browsing without a query also shows each app once, in index order', async () => {
    const page = await catalog().list({});
    expect(page.items.map((entry) => entry.domain)).toEqual([
      'useautumn.com',
      'stripe.com',
      'stripesync.example',
    ]);
  });
});

describe('connector catalogue sections', () => {
  test('a section heading counts apps, the same number its category filter returns', async () => {
    const cat = createConnectorCatalog({
      fetch: (async () =>
        new Response(
          JSON.stringify({
            data: [
              { ...item('a-mcp', 'mcp', 'A', 'a.example'), categories: ['cloud'] },
              { ...item('a-api', 'openapi', 'A', 'a.example'), categories: ['cloud'] },
              { ...item('a-cli', 'cli', 'A', 'a.example'), categories: ['cloud'] },
              { ...item('b-mcp', 'mcp', 'B', 'b.example'), categories: ['cloud'] },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch,
    });
    const { sections, categories } = await cat.sections({});
    const cloud = sections.find((section) => section.key === 'cloud');
    if (!cloud) throw new Error('cloud section missing');
    const page = await cat.list({ category: 'cloud' });
    expect(cloud.total).toBe(2);
    expect(page.total).toBe(cloud.total);
    expect(categories.find((category) => category.key === 'cloud')?.count).toBe(2);
  });
});
