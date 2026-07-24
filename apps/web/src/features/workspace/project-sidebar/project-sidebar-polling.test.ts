import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sandboxSource = readFileSync(
  join(import.meta.dir, 'footer/project-sandbox-alert.tsx'),
  'utf8',
);
const changeRequestSource = readFileSync(
  join(import.meta.dir, 'footer/project-change-requests-nav.tsx'),
  'utf8',
);
const reviewSource = readFileSync(
  join(import.meta.dir, '../../review-center/hooks/use-review-session-summary.ts'),
  'utf8',
);

describe('project sidebar polling', () => {
  test('healthy background queries use low-frequency polling', () => {
    expect(sandboxSource).toContain('return 120_000;');
    expect(changeRequestSource).toContain("useChangeRequests('open', { refetchInterval: 60_000 })");
    expect(reviewSource).toContain('refetchInterval: enabled ? 60_000 : false');
  });

  test('active sandbox builds retain the eight-second status poll', () => {
    expect(sandboxSource).toContain('return 8_000;');
  });
});
