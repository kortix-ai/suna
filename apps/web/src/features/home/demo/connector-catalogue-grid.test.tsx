import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ConnectorCatalogueCard,
  ConnectorCatalogueGrid,
  type ConnectorCatalogueItem,
} from './connector-catalogue-grid';

const SOURCE = readFileSync(
  fileURLToPath(new URL('./connector-catalogue-grid.tsx', import.meta.url)),
  'utf8',
);

const ITEM: ConnectorCatalogueItem = {
  slug: 'linear',
  name: 'Linear',
  domain: 'linear.app',
  description: 'Turn scattered feedback into real tickets.',
};

const OTHER: ConnectorCatalogueItem = {
  slug: 'stripe',
  name: 'Stripe',
  domain: 'stripe.com',
  description: 'Chase overdue invoices.',
};

const noop = () => {};

describe('card', () => {
  test('shows the name and the description', () => {
    const html = renderToStaticMarkup(<ConnectorCatalogueCard item={ITEM} onSelect={noop} />);
    expect(html).toContain('Linear');
    expect(html).toContain('Turn scattered feedback into real tickets.');
  });

  test('is a real button, so keyboard users can reach it', () => {
    const html = renderToStaticMarkup(<ConnectorCatalogueCard item={ITEM} onSelect={noop} />);
    expect(html).toContain('<button');
    expect(html).toContain('type="button"');
  });

  test('labels the action as adding, not as opening a connection', () => {
    const html = renderToStaticMarkup(<ConnectorCatalogueCard item={ITEM} onSelect={noop} />);
    expect(html).toContain('aria-label="Add Linear"');
  });

  test('carries its slug, so a click can be traced to the real connector', () => {
    const html = renderToStaticMarkup(<ConnectorCatalogueCard item={ITEM} onSelect={noop} />);
    expect(html).toContain('data-connector="linear"');
  });

  test('shows no connection state — no tick, no status, no count', () => {
    const html = renderToStaticMarkup(<ConnectorCatalogueCard item={ITEM} onSelect={noop} />);
    expect(html).not.toMatch(/connected/i);
    expect(html).not.toMatch(/needs setup/i);
    expect(html).not.toMatch(/\d+ tools/i);
  });

  test('renders exactly one heading level: none, so it cannot fight the page h1', () => {
    const html = renderToStaticMarkup(<ConnectorCatalogueCard item={ITEM} onSelect={noop} />);
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('<h2');
  });
});

describe('grid', () => {
  test('renders one card per item', () => {
    const html = renderToStaticMarkup(
      <ConnectorCatalogueGrid items={[ITEM, OTHER]} onSelect={noop} />,
    );
    expect(html.match(/data-slot="connector-catalogue-card"/g)).toHaveLength(2);
  });

  test('renders the group label when one is given, and omits it otherwise', () => {
    expect(
      renderToStaticMarkup(
        <ConnectorCatalogueGrid items={[ITEM]} onSelect={noop} label="Engineering" />,
      ),
    ).toContain('Engineering');
    expect(
      renderToStaticMarkup(<ConnectorCatalogueGrid items={[ITEM]} onSelect={noop} />),
    ).not.toContain('<h2');
  });

  test('an empty list renders the grid without cards rather than throwing', () => {
    const html = renderToStaticMarkup(<ConnectorCatalogueGrid items={[]} onSelect={noop} />);
    expect(html).not.toContain('data-slot="connector-catalogue-card"');
  });
});

describe('design system', () => {
  test('is built from Item primitives, not a hand-rolled row', () => {
    expect(SOURCE).toContain("from '@/components/ui/item'");
    expect(SOURCE).toContain('<ItemMedia>');
    expect(SOURCE).toContain('<ItemContent');
    expect(SOURCE).toContain('<ItemActions');
  });

  test('uses the shared favicon avatar rather than bundling logos', () => {
    expect(SOURCE).toContain('FaviconAvatar');
    expect(SOURCE).not.toContain('.svg');
    expect(SOURCE).not.toContain('data:image');
  });

  test('has no spinner, no raw Dialog and no hand-rolled badge span', () => {
    expect(SOURCE).not.toContain('animate-spin');
    expect(SOURCE).not.toContain('Loader2');
    expect(SOURCE).not.toContain('DialogContent');
  });

  test('keeps the responsive card geometry the signed-in catalogues already use', () => {
    expect(SOURCE).toContain('sm:grid-cols-2');
    expect(SOURCE).toContain('lg:grid-cols-3');
  });

  test('fetches nothing — the signed-out path has no session', () => {
    expect(SOURCE).not.toContain('useQuery');
    expect(SOURCE).not.toContain("from '@kortix/sdk'");
  });
});
