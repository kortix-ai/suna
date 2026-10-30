import { expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

import { addSpaceToManifest, appendSpaceTab, setSpaceTabs, slugifySpace, SPACE_TEMPLATES } from './space-templates';

test('slugifySpace produces a manifest-safe key and falls back', () => {
  expect(slugifySpace('My New Space')).toBe('my-new-space');
  expect(slugifySpace('  Ops & Finance!! ')).toBe('ops-finance');
  expect(slugifySpace('***')).toBe('space');
});

test('slugifySpace always yields a valid room name: starts alphanumeric, at most 63 characters', () => {
  expect(slugifySpace('_ops_')).toBe('ops');
  const long = slugifySpace(`${'a'.repeat(62)} b`);
  expect(long.length).toBeLessThanOrEqual(63);
  expect(long).toMatch(/^[a-z0-9][a-z0-9_-]{0,62}$/);
  expect(long.endsWith('-')).toBe(false);
});

test('every template is a list of starting tabs; the first is the default', () => {
  expect(SPACE_TEMPLATES[0]!.tabs.map((t) => t.type)).toEqual(['goals', 'apps', 'artifacts']);
  expect(SPACE_TEMPLATES.find((t) => t.id === 'room')!.tabs).toEqual([]);
  for (const template of SPACE_TEMPLATES) expect(Array.isArray(template.tabs)).toBe(true);
});

test('addSpaceToManifest creates the spaces map when absent and keeps the rest', () => {
  const yaml = '# keep me\nkortix_version: 3\nagents:\n  a:\n    mode: primary\n';
  const text = addSpaceToManifest(yaml, { slug: 'sales', label: 'Sales', description: 'Deals.', tabs: [{ type: 'goals' }] });
  const next = parseYaml(text);
  expect(next.spaces.sales).toEqual({ label: 'Sales', description: 'Deals.', tabs: [{ type: 'goals' }] });
  expect(next.kortix_version).toBe(3);
  expect(text).toContain('# keep me');
});

test('addSpaceToManifest leaves out an empty description and keeps other spaces', () => {
  const yaml = 'spaces:\n  ops:\n    label: Ops\n';
  const next = parseYaml(addSpaceToManifest(yaml, { slug: 'sales', label: 'Sales', description: ' ', tabs: [] }));
  expect(next.spaces.ops).toEqual({ label: 'Ops' });
  expect(next.spaces.sales).toEqual({ label: 'Sales', tabs: [] });
});

test('setSpaceTabs replaces one space tab list and nothing else', () => {
  const yaml = 'spaces:\n  ops:\n    label: Ops\n    tabs:\n      - type: goals\n  sales:\n    label: Sales\n';
  const next = parseYaml(setSpaceTabs(yaml, 'ops', [{ type: 'link', label: 'Status', url: 'https://status.example.com' }]));
  expect(next.spaces.ops).toEqual({ label: 'Ops', tabs: [{ type: 'link', label: 'Status', url: 'https://status.example.com' }] });
  expect(next.spaces.sales).toEqual({ label: 'Sales' });
});

test('appendSpaceTab adds after the tabs in the file, or after the defaults when there are none', () => {
  const link = { type: 'link' as const, url: 'https://example.com' };
  const withTabs = parseYaml(appendSpaceTab('spaces:\n  ops:\n    tabs:\n      - type: apps\n', 'ops', link));
  expect(withTabs.spaces.ops.tabs).toEqual([{ type: 'apps' }, link]);
  const without = parseYaml(appendSpaceTab('spaces:\n  ops:\n    label: Ops\n', 'ops', link));
  expect(without.spaces.ops.tabs).toEqual([{ type: 'goals' }, { type: 'apps' }, { type: 'artifacts' }, link]);
  const empty = parseYaml(appendSpaceTab('spaces:\n  ops:\n    tabs: []\n', 'ops', link));
  expect(empty.spaces.ops.tabs).toEqual([link]);
});

test('setSpaceTabs declares a space an agent only names', () => {
  const next = parseYaml(setSpaceTabs('agents:\n  a:\n    space: ops\n', 'ops', [{ type: 'apps' }]));
  expect(next.spaces.ops).toEqual({ tabs: [{ type: 'apps' }] });
});
