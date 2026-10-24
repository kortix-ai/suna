/**
 * The Connectors browse page showed categories as `· 1`.
 *
 * The client bucketed ONE 48-item page and labelled each bucket with its own
 * length. Measured on 2026-09-11: Composio holds 1540 toolkits in 89
 * categories (`server-monitoring` 42, `developer-tools` 404); the Discover
 * catalogue holds 5531 connectors. A heading reading `Finance · 1` was
 * describing the page, not the catalogue.
 *
 * The catalogue serves its browse page from the server with each section's
 * true size. These tests pin the mapping from those responses to
 * what the grid renders.
 */
import type { DiscoverConnector } from '@kortix/sdk';
import { expect, test } from 'bun:test';

import { browseSections, sectionsPageFromDiscover } from './browse-sections';
import { connectToolkitApp } from './catalog-entry';
import { POPULAR_SECTION } from './connector-categories';

const toolkit = (slug: string, categories: string[] = ['server-monitoring']) => ({
  slug,
  name: slug.toUpperCase(),
  logo: `https://logos.example.test/${slug}.svg`,
  description: `${slug} description`,
  categories,
  isNoAuth: false,
  connected: false,
});

const discover = (slug: string, categories: string[] = ['payments']): DiscoverConnector =>
  ({
    id: `mcp/${slug}`,
    kind: 'mcp',
    slug,
    name: slug.toUpperCase(),
    description: null,
    url: null,
    icon: null,
    domain: `${slug}.example`,
    categories,
    feeds: [],
    popularity: 10,
  }) as DiscoverConnector;

const title = (key: string) => `title:${key}`;

test('a Composio toolkit becomes the same card the paged catalogue renders', () => {
  expect(connectToolkitApp({ ...toolkit('sentry'), isNoAuth: true })).toEqual({
    slug: 'sentry',
    name: 'SENTRY',
    description: 'sentry description',
    imgSrc: 'https://logos.example.test/sentry.svg',
    authType: 'none',
    categories: ['server-monitoring'],
    hasActions: true,
    hasTriggers: false,
    featuredWeight: 0,
    provider: 'composio',
    directId: null,
    directMcpUrl: null,
  });
  expect(
    connectToolkitApp({ ...toolkit('hubspot'), description: undefined, categories: undefined }),
  ).toMatchObject({ description: null, categories: [], authType: 'oauth' });
});

test('each section is capped to its card slice, keeping the true total', () => {
  const page = sectionsPageFromDiscover({
    popular: [],
    sections: [
      { key: 'crm', label: 'CRM', total: 89, items: ['a', 'b', 'c', 'd'].map((slug) => discover(slug, ['crm'])) },
    ],
    categories: [],
  });
  const [section] = browseSections(page, { cardCount: 3, title });
  expect(section.items.map((item) => item.slug)).toEqual(['a', 'b', 'c']);
  expect(section.total).toBe(89);
});

test('a Discover section states its size across the whole catalogue, Popular first', () => {
  const page = sectionsPageFromDiscover({
    popular: [discover('notion', ['productivity']), discover('github', ['developer_tools'])],
    sections: [
      { key: 'finance', label: 'Finance', total: 116, items: [discover('stripe')] },
      {
        key: 'developer-tools',
        label: 'Developer tools',
        total: 187,
        items: [discover('github', ['developer_tools'])],
      },
    ],
    categories: [
      { key: 'finance', label: 'Finance', count: 116 },
      { key: 'developer-tools', label: 'Developer tools', count: 187 },
      { key: 'Other', label: 'Other', count: 3337 },
    ],
  });
  const sections = browseSections(page, { cardCount: 6, title });
  expect(sections.map(({ key, label, total }) => ({ key, label, total }))).toEqual([
    // Popular is a per-item rank, not a category: its total is its own slice,
    // so it never offers "View all" into a bucket with no more members.
    { key: POPULAR_SECTION, label: `title:${POPULAR_SECTION}`, total: 2 },
    { key: 'finance', label: 'title:finance', total: 116 },
    { key: 'developer-tools', label: 'title:developer-tools', total: 187 },
  ]);
  expect(sections[0].items.map((item) => item.key)).toEqual([
    'discover:mcp/notion',
    'discover:mcp/github',
  ]);
  expect(sections[1].items[0]).toMatchObject({ source: 'discover', slug: 'stripe' });
  expect(sections[2].items.map((item) => item.key)).toEqual(['discover:mcp/github']);
  // Discover is titled by key: curated keys resolve to our own titles.
  expect(page.categories).toEqual([
    { key: 'finance', label: 'finance', count: 116 },
    { key: 'developer-tools', label: 'developer-tools', count: 187 },
    { key: 'Other', label: 'Other', count: 3337 },
  ]);
});

test('an unranked Discover catalogue gets no Popular heading', () => {
  const page = sectionsPageFromDiscover({
    popular: [],
    sections: [{ key: 'finance', label: 'Finance', total: 116, items: [] }],
    categories: [],
  });
  const sections = browseSections(page, { cardCount: 6, title });
  expect(sections.map((section) => section.key)).toEqual(['finance']);
});
