import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('./input-group.tsx', import.meta.url), 'utf8');
const exportBlock = source.slice(source.lastIndexOf('export {'));

test('input-group keeps its surviving exports and sizes around a child textarea', () => {
  for (const name of ['InputGroup', 'InputGroupAddon', 'InputGroupButton', 'InputGroupInput', 'InputGroupSearch', 'InputGroupSearchClear', 'InputGroupSearchIcon', 'InputGroupSearchInput']) expect(exportBlock).toMatch(new RegExp(`\\b${name}\\b`));
  expect(source).toContain('has-[>textarea]:h-auto');
});
