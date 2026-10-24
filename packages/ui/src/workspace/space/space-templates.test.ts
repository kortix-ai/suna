import { expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

import { addSpaceToManifest, slugifySpace, spaceBlocks, SPACE_TEMPLATES } from './space-templates';

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

test('spaceBlocks defaults an empty chat room to the slug', () => {
  const channel = SPACE_TEMPLATES.find((t) => t.id === 'channel')!;
  expect(spaceBlocks(channel, 'sales')).toEqual([{ type: 'chat', label: 'Chat', room: 'sales' }]);
  // Blank stays empty; dashboard blocks pass through untouched.
  expect(spaceBlocks(SPACE_TEMPLATES.find((t) => t.id === 'blank')!, 'x')).toEqual([]);
});

test('addSpaceToManifest creates the domains map when absent', () => {
  const yaml = 'kortix_version: 2\nproject:\n  name: Demo\n';
  const next = parseYaml(addSpaceToManifest(yaml, { slug: 'sales', label: 'Sales', blocks: [] }));
  expect(next.domains.sales).toEqual({ label: 'Sales', blocks: [] });
  expect(next.kortix_version).toBe(2); // rest of the manifest preserved
});

test('addSpaceToManifest appends under an existing domains map', () => {
  const yaml = 'domains:\n  ops:\n    label: Ops\n';
  const blocks = spaceBlocks(SPACE_TEMPLATES.find((t) => t.id === 'channel')!, 'sales');
  const next = parseYaml(addSpaceToManifest(yaml, { slug: 'sales', label: 'Sales', blocks }));
  expect(next.domains.ops).toEqual({ label: 'Ops' }); // existing entry untouched
  expect(next.domains.sales.blocks[0]).toEqual({ type: 'chat', label: 'Chat', room: 'sales' });
});
