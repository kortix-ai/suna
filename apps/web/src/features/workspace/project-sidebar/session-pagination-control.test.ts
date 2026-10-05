import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./project-session-list.tsx', import.meta.url), 'utf8');

test('the session list uses one row-aligned pagination control for every section', () => {
  const control = source.slice(source.indexOf('function ShowMoreButton('), source.indexOf('/**', source.indexOf('function ShowMoreButton(')));
  expect(control).toContain('h-8 w-full justify-start px-2');
  expect(control).toContain('disabled={loading}');
  expect(control).toContain("failed ? t('retry') : label");
  expect(source.match(/<ShowMoreButton\b/g)).toHaveLength(3);
});
