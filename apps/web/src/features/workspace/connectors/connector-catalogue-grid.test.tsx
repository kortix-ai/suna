import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '@/components/ui/tooltip';

import type { CatalogueEntry, CatalogueGroup } from './connector-catalogue';
import {
  ConnectorCatalogueCard,
  ConnectorCatalogueGrid,
  ConnectorCatalogueGroupSection,
} from './connector-catalogue-grid';

function entry(overrides: Partial<CatalogueEntry> = {}): CatalogueEntry {
  return {
    slug: 'notion',
    name: 'Notion',
    description: 'Read and write Notion pages and databases.',
    iconUrl: null,
    categories: ['Productivity'],
    connected: false,
    needsSetup: false,
    failing: false,
    official: true,
    toolCount: null,
    ...overrides,
  };
}

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
}

const noop = () => {};

describe('ConnectorCatalogueCard', () => {
  test('an available connector offers to add it', () => {
    const html = render(<ConnectorCatalogueCard entry={entry()} onOpen={noop} onAdd={noop} />);
    expect(html).toContain('Notion');
    expect(html).toContain('Read and write Notion pages and databases.');
    expect(html).toContain('aria-label="Add Notion"');
    expect(html).not.toContain('aria-label="Open Notion"');
  });

  test('a connected connector opens instead of adding, and shows a check', () => {
    const html = render(
      <ConnectorCatalogueCard
        entry={entry({ connected: true, toolCount: 4, description: null })}
        onOpen={noop}
        onAdd={noop}
      />,
    );
    expect(html).toContain('aria-label="Open Notion"');
    expect(html).toContain('text-kortix-green');
    expect(html).toContain('4 tools this project can call');
  });

  test('singularises a one-tool connector', () => {
    const html = render(
      <ConnectorCatalogueCard
        entry={entry({ connected: true, toolCount: 1, description: null })}
        onOpen={noop}
        onAdd={noop}
      />,
    );
    expect(html).toContain('1 tool this project can call');
  });

  test('a read-only member gets no add affordance and a dead button', () => {
    const html = render(<ConnectorCatalogueCard entry={entry()} onOpen={noop} />);
    expect(html).toContain('disabled');
  });

  test('reports a connector that still needs its credential', () => {
    const html = render(
      <ConnectorCatalogueCard
        entry={entry({ connected: true, needsSetup: true })}
        onOpen={noop}
        onAdd={noop}
      />,
    );
    expect(html).toContain('Needs setup');
  });

  test('reports a failing connector instead of its setup state', () => {
    const html = render(
      <ConnectorCatalogueCard
        entry={entry({ connected: true, needsSetup: true, failing: true })}
        onOpen={noop}
        onAdd={noop}
      />,
    );
    expect(html).toContain('Error');
    expect(html).not.toContain('Needs setup');
  });

  test('marks a one-click app, and says what the mark means', () => {
    const html = render(<ConnectorCatalogueCard entry={entry()} onOpen={noop} onAdd={noop} />);
    expect(html).toContain('One-click app — Kortix runs the sign-in');
  });

  test('does not mark a hand-configured connector', () => {
    const html = render(
      <ConnectorCatalogueCard
        entry={entry({ official: false, connected: true })}
        onOpen={noop}
        onAdd={noop}
      />,
    );
    expect(html).not.toContain('One-click app');
  });

  test('renders the app icon the API supplied', () => {
    const html = render(
      <ConnectorCatalogueCard
        entry={entry({ iconUrl: 'https://icons.test/notion.png' })}
        onOpen={noop}
        onAdd={noop}
      />,
    );
    expect(html).toContain('icons.test');
    expect(html).toContain('referrerPolicy="no-referrer"');
  });
});

describe('ConnectorCatalogueGrid', () => {
  test('is a three-column card grid', () => {
    const html = render(
      <ConnectorCatalogueGrid
        entries={[entry(), entry({ slug: 'linear', name: 'Linear' })]}
        onOpen={noop}
        onAdd={noop}
      />,
    );
    expect(html).toContain('lg:grid-cols-3');
    expect(html).toContain('Notion');
    expect(html).toContain('Linear');
  });

  test('renders nothing rather than a placeholder when empty', () => {
    const html = render(<ConnectorCatalogueGrid entries={[]} onOpen={noop} />);
    expect(html).not.toContain('button');
  });
});

function group(count: number, overrides: Partial<CatalogueGroup> = {}): CatalogueGroup {
  return {
    id: 'popular',
    label: 'Popular',
    curated: true,
    entries: Array.from({ length: count }, (_, index) =>
      entry({ slug: `app_${index}`, name: `App ${index}` }),
    ),
    ...overrides,
  };
}

describe('ConnectorCatalogueGroupSection', () => {
  test('labels the group and shows one page of cards', () => {
    const html = render(
      <ConnectorCatalogueGroupSection group={group(9)} onOpen={noop} onAdd={noop} />,
    );
    expect(html).toContain('Popular');
    expect(html).toContain('App 5');
    expect(html).not.toContain('App 6');
  });

  test('offers the pager and View all once a group overflows one page', () => {
    const html = render(
      <ConnectorCatalogueGroupSection group={group(9)} onOpen={noop} onAdd={noop} />,
    );
    expect(html).toContain('aria-label="Previous Popular connectors"');
    expect(html).toContain('aria-label="More Popular connectors"');
    expect(html).toContain('View all');
  });

  test('a group that fits on one page gets no pager', () => {
    const html = render(
      <ConnectorCatalogueGroupSection group={group(3)} onOpen={noop} onAdd={noop} />,
    );
    expect(html).not.toContain('View all');
    expect(html).not.toContain('aria-label="More Popular connectors"');
  });

  test('the first page cannot page backwards', () => {
    const html = render(
      <ConnectorCatalogueGroupSection group={group(9)} onOpen={noop} onAdd={noop} />,
    );
    const prev = html.slice(html.indexOf('aria-label="Previous Popular connectors"'));
    expect(prev.slice(0, 200)).toContain('disabled');
  });

  test('says out loud that a curated group is Kortix filing, not API data', () => {
    const html = render(
      <ConnectorCatalogueGroupSection group={group(3)} onOpen={noop} onAdd={noop} />,
    );
    expect(html).toContain('Grouped by Kortix');
  });

  test('does not claim curation for a group built from the project’s own data', () => {
    const html = render(
      <ConnectorCatalogueGroupSection
        group={group(3, { id: 'connected', label: 'Connected', curated: false })}
        onOpen={noop}
        onAdd={noop}
      />,
    );
    expect(html).toContain('Connected');
    expect(html).not.toContain('Grouped by Kortix');
  });
});
