/**
 * The Connectors browse page showed every Composio category as `· 1`.
 *
 * The client bucketed ONE 48-toolkit page by category and labelled each bucket
 * with its own length. Measured against the live Composio catalogue on
 * 2026-09-11: 1540 toolkits in 89 categories — `server-monitoring` holds 42,
 * `developer-tools` 404 — so a heading reading `Server monitoring · 1` was
 * describing the page, not the catalogue.
 *
 * Sections now come from the server with each category's true size. These
 * tests pin the mapping from that response to what the grid renders.
 */
import { expect, test } from 'bun:test';
import type { CatalogEntry } from './catalog-entry';
import { browseSections, connectToolkitApp, sectionsPageFromConnect } from './connect-sections';

const toolkit = (slug: string, categories: string[] = ['server-monitoring']) => ({
  slug,
  name: slug.toUpperCase(),
  logo: `https://logos.example.test/${slug}.svg`,
  description: `${slug} description`,
  categories,
  isNoAuth: false,
  connected: false,
});

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
  expect(connectToolkitApp({ ...toolkit('hubspot'), description: undefined, categories: undefined }))
    .toMatchObject({ description: null, categories: [], authType: 'oauth' });
});

test('a section states its category’s size, not how many cards it carries', () => {
  const page = sectionsPageFromConnect({
    provider: 'composio',
    sections: [{ key: 'server-monitoring', label: 'server monitoring', total: 42, toolkits: [toolkit('sentry')] }],
    categories: [{ key: 'server-monitoring', label: 'server monitoring', count: 42 }],
  });
  const [section] = browseSections(page, { native: null, cardCount: 6, title });
  expect(section).toMatchObject({ key: 'server-monitoring', label: 'title:server-monitoring', total: 42 });
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
  expect(page.categories).toEqual([{ key: 'images-&-design', label: 'images-&-design', count: 76 }]);
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

test('the native card matches a provider’s own spelling of developer tools', () => {
  const [section] = browseSections(
    {
      sections: [{ key: 'Developer Tools', label: 'Developer Tools', total: 300, apps: [] }],
      categories: [],
    },
    { native, cardCount: 6, title },
  );
  expect(section.items.map((item) => item.key)).toEqual(['computer:computers']);
});

test('no section is invented for the native card when the catalogue has none for it', () => {
  const sections = browseSections(
    { sections: [{ key: 'crm', label: 'crm', total: 89, apps: [] }], categories: [] },
    { native, cardCount: 6, title },
  );
  expect(sections.map((section) => section.key)).toEqual(['crm']);
  expect(sections[0].items).toEqual([]);
});
