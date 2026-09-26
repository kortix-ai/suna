/**
 * The Connectors browse page showed categories as `· 1`.
 *
 * The client bucketed ONE 48-item page and labelled each bucket with its own
 * length. Measured on 2026-09-11: Composio holds 1540 toolkits in 89
 * categories (`server-monitoring` 42, `developer-tools` 404); the Discover
 * catalogue holds 5531 connectors. A heading reading `Finance · 1` was
 * describing the page, not the catalogue.
 *
 * Every catalogue now serves its browse page from the server with each
 * section's true size. These tests pin the mapping from those responses to
 * what the grid renders.
 */
import { expect, test } from 'bun:test';
import type { DiscoverConnector } from '@kortix/sdk';

import type { CatalogEntry } from './catalog-entry';
import {
  browseSections,
  connectToolkitApp,
  sectionsPageFromConnect,
  sectionsPageFromDiscover,
  sectionsPageFromPipedream,
} from './browse-sections';
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

const native: CatalogEntry = {
  source: 'computer',
  key: 'computer:computers',
  slug: 'computers',
  name: 'Computer Tunnels',
  description: null,
  icon: null,
  categories: ['developer-tools'],
  popularity: null,
};

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
  });
  expect(
    connectToolkitApp({ ...toolkit('hubspot'), description: undefined, categories: undefined }),
  ).toMatchObject({ description: null, categories: [], authType: 'oauth' });
});

test('a Composio section states its category’s size, not how many cards it carries', () => {
  const page = sectionsPageFromConnect({
    provider: 'composio',
    sections: [
      {
        key: 'server-monitoring',
        label: 'server monitoring',
        total: 42,
        toolkits: [toolkit('sentry')],
      },
    ],
    categories: [{ key: 'server-monitoring', label: 'server monitoring', count: 42 }],
  });
  const [section] = browseSections(page, { native: null, cardCount: 6, title });
  expect(section).toMatchObject({
    key: 'server-monitoring',
    label: 'title:server-monitoring',
    total: 42,
  });
  expect(section.items.map((item) => item.slug)).toEqual(['sentry']);
  expect(section.items[0]).toMatchObject({ source: 'easy-connect', key: 'easy-connect:sentry' });
});

test('Composio sections and categories are titled by key, so labels match the paged grid', () => {
  // Composio names are lowercase ("server monitoring"). The key is what
  // `localizedSectionTitle` humanizes, and what an open category is keyed by.
  const page = sectionsPageFromConnect({
    provider: 'composio',
    sections: [{ key: 'images-&-design', label: 'images & design', total: 76, toolkits: [] }],
    categories: [{ key: 'images-&-design', label: 'images & design', count: 76 }],
  });
  expect(page.sections[0]).toMatchObject({ key: 'images-&-design', label: 'images-&-design' });
  expect(page.categories).toEqual([
    { key: 'images-&-design', label: 'images-&-design', count: 76 },
  ]);
});

test('each section is capped to its card slice', () => {
  const page = sectionsPageFromConnect({
    provider: 'composio',
    sections: [
      {
        key: 'crm',
        label: 'crm',
        total: 89,
        toolkits: ['a', 'b', 'c', 'd'].map((slug) => toolkit(slug, ['crm'])),
      },
    ],
    categories: [],
  });
  const [section] = browseSections(page, { native: null, cardCount: 3, title });
  expect(section.items.map((item) => item.slug)).toEqual(['a', 'b', 'c']);
  expect(section.total).toBe(89);
});

test('the native Computers card leads the developer-tools section without changing its count', () => {
  // It is the only way to discover Computer Tunnels on the browse page. The
  // catalogue does not publish it, so it must not inflate the catalogue total.
  const page = sectionsPageFromConnect({
    provider: 'composio',
    sections: [
      {
        key: 'developer-tools',
        label: 'developer tools',
        total: 404,
        toolkits: ['github', 'gitlab', 'linear'].map((slug) => toolkit(slug, ['developer-tools'])),
      },
      { key: 'crm', label: 'crm', total: 89, toolkits: [toolkit('hubspot', ['crm'])] },
    ],
    categories: [],
  });
  const [developerTools, crm] = browseSections(page, { native, cardCount: 3, title });
  expect(developerTools.items.map((item) => item.key)).toEqual([
    'computer:computers',
    'easy-connect:github',
    'easy-connect:gitlab',
  ]);
  expect(developerTools.total).toBe(404);
  expect(crm.items.map((item) => item.key)).toEqual(['easy-connect:hubspot']);
});

test('Pipedream keeps its own section labels and matches its spelling of developer tools', () => {
  const page = sectionsPageFromPipedream({
    sections: [{ key: 'Developer Tools', label: 'Developer Tools', total: 300, apps: [] }],
    categories: [{ key: 'Developer Tools', label: 'Developer Tools', count: 300 }],
  });
  const [section] = browseSections(page, { native, cardCount: 6, title });
  expect(section).toMatchObject({ label: 'title:Developer Tools', total: 300 });
  expect(section.items.map((item) => item.key)).toEqual(['computer:computers']);
  expect(page.categories).toEqual([{ key: 'Developer Tools', label: 'Developer Tools', count: 300 }]);
});

test('no section is invented for the native card when the catalogue has none for it', () => {
  const page = sectionsPageFromConnect({
    provider: 'composio',
    sections: [{ key: 'crm', label: 'crm', total: 89, toolkits: [] }],
    categories: [],
  });
  const sections = browseSections(page, { native, cardCount: 6, title });
  expect(sections.map((section) => section.key)).toEqual(['crm']);
  expect(sections[0].items).toEqual([]);
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
  const sections = browseSections(page, { native, cardCount: 6, title });
  expect(sections.map(({ key, label, total }) => ({ key, label, total }))).toEqual([
    // Popular is a per-item rank, not a category: its total is its own slice,
    // so it never offers "View all" into a bucket with no more members.
    { key: POPULAR_SECTION, label: `title:${POPULAR_SECTION}`, total: 2 },
    { key: 'finance', label: 'title:finance', total: 116 },
    { key: 'developer-tools', label: 'title:developer-tools', total: 187 },
  ]);
  expect(sections[0].items.map((item) => item.key)).toEqual(['discover:mcp/notion', 'discover:mcp/github']);
  expect(sections[1].items[0]).toMatchObject({ source: 'discover', slug: 'stripe' });
  // The native card joins Discover's developer tools too, without the count.
  expect(sections[2].items.map((item) => item.key)).toEqual([
    'computer:computers',
    'discover:mcp/github',
  ]);
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
  const sections = browseSections(page, { native: null, cardCount: 6, title });
  expect(sections.map((section) => section.key)).toEqual(['finance']);
});
