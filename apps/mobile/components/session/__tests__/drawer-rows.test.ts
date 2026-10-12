import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = ['ProjectLeftDrawer.tsx', 'DrawerSessionRows.tsx', 'DrawerNavRows.tsx']
  .map((file) => {
    try { return readFileSync(resolve(import.meta.dir, '..', file), 'utf8'); }
    catch { return ''; }
  }).join('\n');
// The 99+ cap lives in the shared CountBadge (#9687); the drawer rows must render it.
const countBadge = readFileSync(resolve(import.meta.dir, '../../kortix/count-badge.tsx'), 'utf8');

test('drawer renders nested session rows, review count and switcher accessibility labels', () => {
  expect(source).toContain('nested ? `${title}, sub-agent session, ${statusLabel}`');
  expect(countBadge).toContain('count > 99 ? \'99+\' : String(count)');
  expect(source).toContain('<CountBadge');
  expect(source).toContain('`Switch project, ${projectName}, ${accountName}`');
  expect(source).toContain('TRUNK_X_TOP_LEVEL + (nested ? NESTED_LEAD : 0)');
});
