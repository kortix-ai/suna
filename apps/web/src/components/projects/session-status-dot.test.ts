import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '../../..');
const read = (relative: string) => readFileSync(join(root, relative), 'utf8');

const DOT = 'src/components/projects/session-status-dot.tsx';
const SIDEBAR = 'src/features/workspace/project-sidebar/project-session-list.tsx';
const ROW = 'src/features/crafts/craft-report-row.tsx';
const LEGEND = 'src/features/crafts/craft-run-legend.tsx';
const DETAIL = 'src/features/crafts/craft-report-detail.tsx';

/**
 * The status circle's paint table is a SINGLE source of truth. It lived inside
 * the sidebar's session list until the craft run strips needed the same glyph;
 * two copies is exactly how `done` ends up a muted check on one screen and a
 * green ring on another.
 *
 * These are source assertions, not render assertions, because the invariant
 * being protected is "there is only one of these" — which no amount of
 * rendering one of them can prove.
 */
describe('session status dot is the only paint table', () => {
  test('only session-status-dot.tsx defines STATUS_DOT_STYLE', () => {
    expect(read(DOT)).toContain('const STATUS_DOT_STYLE');
    for (const file of [SIDEBAR, ROW, LEGEND, DETAIL]) {
      expect(read(file)).not.toContain('STATUS_DOT_STYLE');
    }
  });

  test('every consumer imports the dot rather than drawing its own circle', () => {
    for (const file of [SIDEBAR, ROW, LEGEND, DETAIL]) {
      expect(read(file)).toContain("from '@/components/projects/session-status-dot'");
      // A hand-rolled <circle> here would be a second glyph by another name.
      expect(read(file)).not.toContain('<circle');
    }
  });

  test('green is spent on exactly the two live/actionable states', () => {
    const source = read(DOT);
    const greenLines = source
      .split('\n')
      .filter((line) => line.includes('var(--kortix-green)'))
      .map((line) => line.trim());
    expect(greenLines).toHaveLength(2);
    expect(greenLines.some((line) => line.startsWith("'needs-you'"))).toBe(true);
    expect(greenLines.some((line) => line.startsWith('running:'))).toBe(true);
    // `done` is muted on purpose — a check is not a licence to go green.
    expect(source).toContain("done: { color: 'var(--muted-foreground)', glyph: 'check'");
  });

  test('the sidebar resolves display status instead of re-deriving paint', () => {
    const source = read(SIDEBAR);
    expect(source).toContain('status={sessionDisplayStatus(session, reviewCount)}');
    expect(source).toContain('awaiting your review');
  });
});
