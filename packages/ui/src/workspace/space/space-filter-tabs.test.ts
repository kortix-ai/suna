import { beforeEach, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DEFAULT_PROJECT_DOMAIN, groupBySpace, listSpaces, type ProjectDomain } from '@kortix/sdk';

// The Goals and Artifacts pages filter by space. Nothing is bound yet in a
// project that just declared a space: the selected space still needs a tab,
// and a stale stored space must not hide every item.

const config = {
  agents: [{ name: 'closer', domain: 'sales' }],
  domains: [{ name: 'sales', label: 'Sales' }] as ProjectDomain[],
};
let active: string | null = null;
let param: string | null = null;

const sdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({ ...sdkReact, useProjectConfig: () => config }));
const store = await import('../../internal/stores/active-domain-store');
mock.module('../../internal/stores/active-domain-store', () => ({
  ...store,
  useActiveDomain: () => [active, (next: string | null) => (active = next)],
}));
const provider = await import('../../providers/ui-provider');
mock.module('../../providers/ui-provider', () => ({
  ...provider,
  useUiSearchParams: () => new URLSearchParams(param ? { space: param } : {}),
  useUiRouter: () => ({ push: () => {}, replace: () => {} }),
  useUiPathname: () => '/projects/p1/goals',
}));

const { SpaceFilterTabs } = await import('./space-filter-tabs');
const { useSpaceFilter } = await import('./use-space-filter');
const { ALL_DOMAINS } = await import('../../customize/shared/catalog/domain-filter-tabs');

// Two unbound goals: both resolve to project-wide.
const items = [{ id: 'g1' }, { id: 'g2' }];
const groups = groupBySpace(items, config.domains, () => DEFAULT_PROJECT_DOMAIN);

function tabs(value: string, spaces = listSpaces(config)) {
  return renderToStaticMarkup(
    createElement(SpaceFilterTabs, { spaces, groups, value, onValueChange: () => {} }),
  );
}

function filterValue(): string {
  let value = '';
  const Probe = () => {
    value = useSpaceFilter('p1')[0];
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  return value;
}

beforeEach(() => {
  active = null;
  param = null;
});

test('the selected space has a tab with 0 when nothing is bound to it', () => {
  const html = tabs('sales');
  expect(html).toContain('aria-label="Filter by space"');
  expect(html).toMatch(/aria-selected="true"[^>]*>Sales<span[^>]*>0</);
  expect(html).toContain('Project-wide');
  expect(html).toContain('>All<');
});

test('a project without spaces shows no filter', () => {
  expect(tabs(ALL_DOMAINS, [])).toBe('');
});

test('the filter reads ?space=, then the active space; a removed space falls back to All', () => {
  active = 'sales';
  expect(filterValue()).toBe('sales');
  param = DEFAULT_PROJECT_DOMAIN;
  expect(filterValue()).toBe(DEFAULT_PROJECT_DOMAIN);
  param = null;
  active = 'removed-space';
  expect(filterValue()).toBe(ALL_DOMAINS);
});
