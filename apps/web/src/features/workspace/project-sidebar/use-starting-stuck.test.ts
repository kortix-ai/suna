import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `apps/web` has no jsdom/happy-dom and no `@testing-library/react`, so an
 * interval cannot be driven here (see `use-restart-project-session.test.ts`
 * for the established split). The stuck DECISION is pinned by the SDK's
 * `status-vocabulary.test.ts` and the pixel output by
 * `session-brief-hover-card.stuck.test.tsx`; this file pins the one thing
 * neither can see: that the hook's clock actually runs while a row sits in
 * the starting family. The list's data does not change while a boot is
 * wedged, so a hook that lost its interval would silently return to the
 * original bug — a stuck boot that never flips — with every decision test
 * still green.
 */

const hookSource = readFileSync(join(import.meta.dir, 'use-starting-stuck.ts'), 'utf8');

function between(source: string, open: string, close: string): string {
  const start = source.indexOf(open);
  if (start === -1) throw new Error(`anchor not found: ${open}`);
  const end = source.indexOf(close, start + open.length);
  if (end === -1) throw new Error(`anchor not found after ${open}: ${close}`);
  return source.slice(start, end);
}

describe('useStartingStuck — the clock that makes the flip land', () => {
  const body = between(hookSource, 'export function useStartingStuck', '\n}\n');

  test('ticks only while the row sits in the starting family', () => {
    // The interval lives inside the `starting` guard: a settled row runs no
    // timer, so a full sidebar pays one 5s interval per booting session and
    // nothing otherwise.
    expect(body).toContain('if (!starting) return;');
    expect(body).toContain('setInterval(() => setNow(Date.now()), 5_000)');
  });

  test('the tick feeds the SDK predicate, and the predicate gates the answer', () => {
    expect(body).toContain('starting && sessionStartingStuck(session, now)');
  });
});

describe('the row hands one stuck read to every surface', () => {
  const rowSource = readFileSync(
    join(import.meta.dir, 'project-session-list.tsx'),
    'utf8',
  );

  test('dot, hover card and screen-reader description read the same flag', () => {
    expect(rowSource).toContain('const startingStuck = useStartingStuck(session)');
    expect(rowSource).toMatch(/<SessionStatusDot session=\{session\} reviewCount=\{reviewCount\} stuck=\{startingStuck\}/);
    expect(rowSource).toMatch(/stuck=\{startingStuck\}\n\s+onRestart=/);
    expect(rowSource).toMatch(/changeRequests=\{changeRequests\}\n\s+stuck=\{startingStuck\}/);
  });
});
