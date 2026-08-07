import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('./session-config-indicator.tsx', import.meta.url)),
  'utf8',
);

describe('SessionConfigIndicator notification level', () => {
  test('keeps stale config in the header instead of opening a persistent toast', () => {
    expect(source).toContain('<Popover');
    expect(source).not.toContain("warningToast('Agent config is out of date'");
    expect(source).not.toContain('duration: Number.POSITIVE_INFINITY');
  });
});
