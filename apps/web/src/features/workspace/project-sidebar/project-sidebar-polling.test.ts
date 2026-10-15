import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) => readFileSync(join(import.meta.dir, path), 'utf8');

const sandboxSource = read('footer/sandbox-health.ts');
const sandboxStateSource = read('footer/sandbox-alert-state.ts');
const reviewPillSource = read('footer/project-change-requests-nav.tsx');
const reviewSource = read('../../review-center/hooks/use-review-session-summary.ts');

/**
 * Every surface that stays mounted while a project is open, and polls from
 * there. A list read here grows with the project's history and is repeated
 * by every open tab (KRTX-1727 scenario F: a 565 KB change-request list and
 * the whole review inbox, every 60 s).
 */
const ALWAYS_MOUNTED = [
  'project-session-list.tsx',
  'footer/project-change-requests-nav.tsx',
  '../project-sessions/project-sessions-view.tsx',
  '../project-layout/project-shell.tsx',
  '../capabilities/project-settings/project-settings-page.tsx',
  '../../review-center/hooks/use-review-session-summary.ts',
];

describe('project sidebar polling', () => {
  test('healthy background queries use low-frequency polling', () => {
    expect(sandboxSource).toContain('sandboxHealthRefetchInterval(query.state.data)');
    expect(sandboxStateSource).toContain('return 120_000;');
    // The footer Review pill reads the shared inbox summary (polled at 60s) and
    // runs no change-request poll of its own.
    expect(reviewPillSource).toContain('useReviewSessionSummary(projectId)');
    expect(reviewPillSource).not.toContain('useChangeRequests');
    expect(reviewSource).toContain('refetchInterval: 60_000');
  });

  test('active sandbox builds retain the eight-second status poll', () => {
    expect(sandboxStateSource).toContain("if (state === 'building') return 8_000;");
  });
});

// KRTX-2316: the always-mounted surfaces read counts and bounded pages.
describe('always-mounted surfaces read no unbounded list', () => {
  for (const path of ALWAYS_MOUNTED) {
    const source = read(path);

    test(`${path} reads the review counts, never the review list`, () => {
      expect(source).not.toMatch(/listReviewItems|useReviewItems|useReviewItemPages|review\/items/);
    });

    test(`${path} reads no whole change-request history`, () => {
      expect(source).not.toMatch(/status=all/);
      expect(source).not.toMatch(/(?:list|fetch|use)ChangeRequests\([^)]*'all'/);
      for (const call of source.match(/listChangeRequests\([^;]*/g) ?? []) {
        expect(call).toContain('limit');
      }
    });
  }

  test('the review summary hook reads the summary route', () => {
    expect(reviewSource).toContain('useReviewSummary(projectId');
  });
});
