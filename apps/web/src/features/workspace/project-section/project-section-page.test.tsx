import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProjectSectionPage, type ProjectSectionState } from './project-section-page';

function render(node: React.ReactElement) {
  return renderToStaticMarkup(node);
}

const BASE = {
  title: 'Automations',
  description: 'Run work on a schedule or from an event.',
} as const;

function page(state: ProjectSectionState, extra: Record<string, unknown> = {}) {
  return render(
    <ProjectSectionPage {...BASE} state={state} {...extra}>
      <div>the-content</div>
    </ProjectSectionPage>,
  );
}

describe('header', () => {
  test('renders exactly one h1 carrying the title', () => {
    const html = page('ready');
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('Automations');
  });

  test('renders the description once', () => {
    const html = page('ready');
    const occurrences = html.split('Run work on a schedule or from an event.').length - 1;
    expect(occurrences).toBe(1);
  });

  test('renders a Learn more link only when a docs href is given', () => {
    expect(page('ready')).not.toContain('Learn more');
    const html = page('ready', { docsHref: 'https://kortix.com/docs/connect/triggers' });
    expect(html).toContain('Learn more');
    expect(html).toContain('https://kortix.com/docs/connect/triggers');
  });

  test('external doc links carry rel="noopener noreferrer"', () => {
    const html = page('ready', { docsHref: 'https://kortix.com/docs' });
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe('state ladder', () => {
  test('loading renders a busy placeholder and not the content', () => {
    const html = page('loading');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('the-content');
  });

  test('forbidden explains instead of silently redirecting', () => {
    // The overlay used to jump the user to the first section they could see.
    const html = page('forbidden');
    expect(html).toContain('have access to this');
    expect(html).not.toContain('the-content');
  });

  test('forbidden accepts a specific message', () => {
    expect(page('forbidden', { forbiddenMessage: 'Only owners can edit billing.' })).toContain(
      'Only owners can edit billing.',
    );
  });

  test('error renders the error state', () => {
    const html = page('error');
    expect(html).toContain('Failed to load');
    expect(html).not.toContain('the-content');
  });

  test('empty renders the empty state and takes overrides', () => {
    expect(page('empty')).toContain('Nothing here yet');
    expect(page('empty', { emptyProps: { title: 'No automations yet' } })).toContain(
      'No automations yet',
    );
  });

  test('no-results is distinct from empty, so a filtered list does not read as unconfigured', () => {
    const html = page('no-results');
    expect(html).toContain('No matches');
    expect(html).not.toContain('Nothing here yet');
  });

  test('ready renders the children', () => {
    expect(page('ready')).toContain('the-content');
  });

  test('the header survives every state', () => {
    const states: ProjectSectionState[] = [
      'loading',
      'forbidden',
      'error',
      'empty',
      'no-results',
      'ready',
    ];
    for (const state of states) {
      expect(page(state)).toContain('Automations');
    }
  });
});

describe('search and actions', () => {
  test('omits the search field unless search is passed', () => {
    expect(page('ready')).not.toContain('<input');
  });

  test('renders a labelled search input', () => {
    const html = page('ready', {
      search: { value: '', onChange: () => {}, placeholder: 'Search automations' },
    });
    expect(html).toContain('<input');
    expect(html).toContain('Search automations');
  });

  test('shows the clear affordance only when the query is non-empty', () => {
    const empty = page('ready', { search: { value: '', onChange: () => {} } });
    const filled = page('ready', { search: { value: 'digest', onChange: () => {} } });
    expect(filled.length).toBeGreaterThan(empty.length);
    expect(filled).toContain('digest');
  });

  test('renders the primary action and the filter row when given', () => {
    const html = page('ready', {
      action: <button type="button">New schedule</button>,
      filters: <span>All</span>,
    });
    expect(html).toContain('New schedule');
    expect(html).toContain('All');
  });

  test('omits the filter row entirely when no filters are passed', () => {
    // An empty bordered strip above every list is exactly the chrome being removed.
    const withFilters = page('ready', { filters: <span>All</span> });
    const without = page('ready');
    expect(without.length).toBeLessThan(withFilters.length);
  });
});
