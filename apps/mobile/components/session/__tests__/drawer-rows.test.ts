import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = ['ProjectLeftDrawer.tsx', 'DrawerSessionRows.tsx', 'DrawerNavRows.tsx']
  .map((file) => {
    try { return readFileSync(resolve(import.meta.dir, '..', file), 'utf8'); }
    catch { return ''; }
  }).join('\n');

test('drawer renders nested session rows, review count and switcher accessibility labels', () => {
  expect(source).toContain('nested ? `${title}, sub-agent session, ${statusLabel}`');
  // #9687 moved the "99+" clamp into the shared `CountBadge`; the drawer's
  // review count reaches it through the `waiting` tone.
  expect(source).toContain('trailing={<CountBadge count={reviewNeedsYouCount} tone="waiting" />}');
  expect(source).toContain('`Switch project, ${projectName}, ${accountName}`');
  expect(source).toContain('TRUNK_X_TOP_LEVEL + (nested ? NESTED_LEAD : 0)');
});
