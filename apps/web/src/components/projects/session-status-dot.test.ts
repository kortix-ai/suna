import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '../../..');
const read = (relative: string) => readFileSync(join(root, relative), 'utf8');

const DOT = 'src/components/projects/session-status-dot.tsx';
const SIDEBAR = 'src/features/workspace/project-sidebar/project-session-list.tsx';
const DOT_WRAPPER = 'src/features/crafts/craft-run-dot.tsx';
const ROW = 'src/features/crafts/craft-report-row.tsx';
const LEGEND = 'src/features/crafts/craft-run-legend.tsx';
const DETAIL = 'src/features/crafts/craft-report-detail.tsx';

/** Every craft surface that paints a run's state, directly or through the
 *  run-dot wrapper. `craft-run-dot.tsx` is the wrapper the strips share; it adds
 *  the link and the tooltip and owns no paint of its own. */
const CRAFT_SURFACES = [DOT_WRAPPER, ROW, LEGEND, DETAIL];

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
    for (const file of [SIDEBAR, ...CRAFT_SURFACES]) {
      expect(read(file)).not.toContain('STATUS_DOT_STYLE');
    }
  });

  test('every consumer imports the dot rather than drawing its own circle', () => {
    // ROW reaches the glyph through `craft-run-dot`, not directly — the link
    // and tooltip wrapper is shared, so only the wrapper and the surfaces that
    // render a bare glyph import the dot itself.
    for (const file of [SIDEBAR, DOT_WRAPPER, LEGEND, DETAIL]) {
      expect(read(file)).toContain("from '@/components/projects/session-status-dot'");
    }
    expect(read(ROW)).toContain("from './craft-run-dot'");
    for (const file of [SIDEBAR, ...CRAFT_SURFACES]) {
      // A hand-rolled <circle> here would be a second glyph by another name.
      expect(read(file)).not.toContain('<circle');
    }
  });

  test('the two run-only states live in the same paint table, not a fork', () => {
    // A craft run is `retrying` or `skipped` and a session never is. Forking
    // the table for two rows is how `done` ends up green on one screen.
    const source = read(DOT);
    expect(source).toContain("retrying: { color: 'var(--kortix-yellow)'");
    expect(source).toContain("skipped: { color: 'var(--muted-foreground)', glyph: 'dash'");
    // And they must NOT have been added to the session union: no session can be
    // either, so every session surface would gain two dead cases.
    expect(read('src/components/projects/session-label.ts')).not.toContain('retrying');
    expect(read('src/components/projects/session-label.ts')).not.toContain("skipped");
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

  test('needs-you is HOLLOW and running is FILLED — the same green, told apart', () => {
    // These two shared a colour AND a fill, differing only by inner radius
    // (3.2 vs 4), which nobody can see at 16px. A session waiting on you looked
    // identical to one working. Hollow-vs-filled is the distinction.
    const source = read(DOT);
    expect(source).toContain(
      "'needs-you': { color: 'var(--kortix-green)', glyph: 'ring', fill: false, ringWidth: 2.25 }",
    );
    expect(source).toContain("running: { color: 'var(--kortix-green)', glyph: 'ring', fill: true }");
    // And the radius ternary that encoded the invisible difference is gone.
    expect(source).not.toContain("'needs-you' ? 3.2");
  });

  test('needs-you carries a heavier ring, so it survives desaturation', () => {
    // Removing the fill left it the same SHAPE as `stopped`, separated only by
    // hue — and green vs muted are nearly the same lightness, differing almost
    // entirely in chroma. Desaturated they collapse, and the only actionable
    // state in the list becomes indistinguishable from a dead one. Weight is
    // what survives, so this is not decoration and must not be "tidied away".
    const source = read(DOT);
    expect(source).toContain('ringWidth: 2.25');
    // It must actually reach the SVG, not just sit in the table.
    expect(source).toContain('strokeWidth={style.ringWidth ?? 1.5}');
    // And `stopped` must NOT have one, or the distinction disappears again.
    expect(source).toContain(
      "stopped: { color: 'var(--muted-foreground)', glyph: 'ring', fill: false }",
    );
  });

  test('no two states share the same colour + glyph + fill', () => {
    // The real invariant behind both of the tests above: a state a reader cannot
    // distinguish from another is a state that carries no information. Parsed
    // from the table so a NEW row cannot quietly collide with an existing one.
    const source = read(DOT);
    const table = source.slice(source.indexOf('const STATUS_DOT_STYLE'));
    const body = table.slice(table.indexOf('= {') + 3, table.indexOf('\n};'));
    const rows = [...body.matchAll(/^\s*'?([\w-]+)'?:\s*\{\s*color:\s*'([^']+)',\s*glyph:\s*'(\w+)',\s*fill:\s*(true|false)/gm)];
    // Every status must be matched, or this test is silently checking nothing.
    expect(rows.length).toBe(9);
    const seen = new Map<string, string>();
    for (const [, status, color, glyph, fill] of rows) {
      // `starting`, `legacy` and `retrying` render their own icon and never read
      // glyph/fill, so identical rows there are not a collision.
      if (status === 'starting' || status === 'legacy' || status === 'retrying') continue;
      const key = `${color}|${glyph}|${fill}`;
      const clash = seen.get(key);
      expect(clash, `${status} is indistinguishable from ${clash}`).toBeUndefined();
      seen.set(key, status);
    }
  });

  test('the sidebar resolves display status instead of re-deriving paint', () => {
    const source = read(SIDEBAR);
    expect(source).toContain('status={sessionDisplayStatus(session, reviewCount)}');
    expect(source).toContain('awaiting your review');
  });
});
