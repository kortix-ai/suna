import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The review count renders through CountBadge, which owns the 99+ cap (#9687).
const source = ['ProjectLeftDrawer.tsx', 'DrawerSessionRows.tsx', 'DrawerNavRows.tsx', '../kortix/count-badge.tsx']
  .map((file) => {
    try { return readFileSync(resolve(import.meta.dir, '..', file), 'utf8'); }
    catch { return ''; }
  }).join('\n');

test('drawer renders nested session rows, review count and switcher accessibility labels', () => {
  expect(source).toContain('nested ? `${title}, sub-agent session, ${statusLabel}`');
  expect(source).toContain('count > 99 ? \'99+\' : String(count)');
  expect(source).toContain('`Switch project, ${projectName}, ${accountName}`');
  expect(source).toContain('TRUNK_X_TOP_LEVEL + (nested ? NESTED_LEAD : 0)');
});
