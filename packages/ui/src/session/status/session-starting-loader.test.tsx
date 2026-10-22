import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canOfferBootRestart } from './session-starting-loader';

/**
 * KRTX-1671: the stuck-boot restart offer follows the same verdict as every
 * session menu (#9211). A member who can open a teammate's session still saw
 * the Restart escape hatch in the boot loader and the connecting banner after
 * 45s, and the server answered the click 403. The offer is the
 * `canOfferBootRestart` decision, so its contract lives here.
 */
describe('canOfferBootRestart', () => {
  test('a member without the lifecycle verdict is not offered the stuck-boot restart', () => {
    expect(canOfferBootRestart({ can_manage_lifecycle: false }, 'p1', 's1')).toBe(false);
  });

  test('the owner and a project manager keep the escape hatch', () => {
    expect(canOfferBootRestart({ can_manage_lifecycle: true }, 'p1', 's1')).toBe(true);
  });

  test('an absent row cannot deny yet: a fresh session boots before its row lands', () => {
    expect(canOfferBootRestart(undefined, 'p1', 's1')).toBe(true);
    expect(canOfferBootRestart({}, 'p1', 's1')).toBe(true);
  });

  test('no session coordinates, no restart — the offer needs somewhere to restart', () => {
    expect(canOfferBootRestart({ can_manage_lifecycle: true }, undefined, 's1')).toBe(false);
    expect(canOfferBootRestart({ can_manage_lifecycle: true }, 'p1', '')).toBe(false);
  });
});

/**
 * `apps/web` has no jsdom/`@testing-library/react` (see
 * `hooks/projects/use-restart-project-session.test.ts` for the split), so the
 * restart click itself cannot be driven here. The scan pins the WIRING both
 * boot surfaces must keep: each one takes the canonical
 * `useRestartProjectSession` hook — the optimistic `/start` seed, its rollback
 * on rejection, and the runtime-guard / `['opencode']` / sidebar invalidations
 * live there — and no surface re-rolls its own `useMutation` again. What the
 * hook DOES is proven against a real QueryClient in that hook's test file.
 *
 * The stuck offer must also follow the session's lifecycle verdict
 * (`can_manage_lifecycle`), not just the presence of a session id — that is
 * the KRTX-1671 defect. The verdict read cannot run here (no DOM, no clock
 * past 45s), so that wiring is pinned per surface the same way.
 */
describe('restart wiring — the source the components actually render', () => {
  const source = readFileSync(join(import.meta.dir, 'session-starting-loader.tsx'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const loaderBody = code.slice(
    code.indexOf('export function SessionStartingLoader('),
    code.indexOf('export function SessionConnectingBanner('),
  );
  const bannerBody = code.slice(code.indexOf('export function SessionConnectingBanner('));

  test('neither surface hand-rolls a restart mutation anymore', () => {
    expect(code).not.toContain('useMutation');
    expect(code).not.toContain('useQueryClient');
    expect(code).not.toContain('restartProjectSession');
    expect(code).not.toContain('sessionStartKey');
  });

  test('both surfaces take the canonical restart hook', () => {
    expect(loaderBody).toContain('useRestartProjectSession(');
    expect(bannerBody).toContain('useRestartProjectSession(');
  });

  test('both surfaces wire the canonical restart and pending state to their control', () => {
    expect(loaderBody).toContain('onRestart={restart.restart}');
    expect(loaderBody).toContain('pending={restart.isPending}');
    expect(bannerBody).toContain('disabled={restart.isPending}');
    expect(bannerBody).toContain('onClick={restart.restart}');
  });

  test('both surfaces reset their boot clock only when a restart settles without an error', () => {
    expect(loaderBody).toContain('useRestartedBootClock(restart)');
    expect(bannerBody).toContain('useRestartedBootClock(restart)');
  });

  test('both surfaces read the session row through the one canonical reader', () => {
    expect(loaderBody).toContain('useProjectSession(projectId, sessionId)');
    expect(bannerBody).toContain('useProjectSession(projectId, sessionId)');
  });

  test('both surfaces gate the offer through the shared lifecycle verdict, never ids alone', () => {
    expect(loaderBody).toContain('canOfferBootRestart(session, projectId, sessionId)');
    expect(bannerBody).toContain('canOfferBootRestart(session, projectId, sessionId)');
    expect(code).not.toContain('canRestart = !!projectId && !!sessionId');
  });
});
