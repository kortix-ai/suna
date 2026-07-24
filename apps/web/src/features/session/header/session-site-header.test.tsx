import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('./session-site-header.tsx', import.meta.url)),
  'utf8',
);

describe('SessionSiteHeader sidebar toggle', () => {
  test('connects collapsed-toggle hover to the sidebar peek controller', () => {
    expect(source).toContain('onPointerEnter={sidebarState ===');
    expect(source).toContain('peekEnter');
    expect(source).toContain('peekLeave');
  });
});
