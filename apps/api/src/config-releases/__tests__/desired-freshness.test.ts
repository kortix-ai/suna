/**
 * `resolveDesiredRelease` never forces a mirror fetch (KRTX-629).
 *
 * It ran `invalidateProjectMirror` on every call, so every descriptor request
 * paid a `git fetch` (prod p50 1.07 s, 100k requests a day, 2026-10-13): on
 * every boot's critical path and on every box's 60 s convergence tick. A base
 * move Kortix makes or proxies already drops the stamp in every API process
 * (`notifyBaseBranchMoved`), and the mirror refreshes itself after
 * `KORTIX_GIT_REFRESH_INTERVAL_MS`.
 */
import { describe, expect, test } from 'bun:test';

const SRC = await Bun.file(new URL('../desired.ts', import.meta.url).pathname).text();
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('resolveDesiredRelease reads the mirror as it is', () => {
  test('nothing in it invalidates or force-refreshes the mirror', () => {
    expect(code).not.toContain('invalidateProjectMirror');
    expect(code).not.toContain('invalidate(');
    expect(code).not.toMatch(/refreshMirror\([^)]*true/);
  });
});
