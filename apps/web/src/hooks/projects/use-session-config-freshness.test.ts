import type { SessionConfigRelease, SessionConfigState, SessionReloadResult } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CONFIG_FRESHNESS_STALE_TIME_MS,
  reloadNotAppliedCopy,
  reloadResultTone,
  sessionConfigNotice,
} from './use-session-config-freshness';

const state = (over: Partial<SessionConfigState>): SessionConfigState => ({
  base_ref: 'main',
  running_etag: 'aaaaaaaaaaaaaaaa',
  latest_etag: 'aaaaaaaaaaaaaaaa',
  commit_sha: 'c'.repeat(40),
  stale: false,
  sandbox_reachable: true,
  ...over,
});

describe('sessionConfigNotice', () => {
  test('a session that is behind reports both hashes', () => {
    expect(
      sessionConfigNotice(
        state({ stale: true, running_etag: 'old0old0old0old0', latest_etag: 'new1new1new1new1' }),
      ),
    ).toEqual({ kind: 'stale', running: 'old0old0old0old0', latest: 'new1new1new1new1' });
  });

  test('a current session renders NOTHING — not a green tick', () => {
    // A permanent "up to date" badge is chrome on every session forever to say
    // the thing that is true almost always. Silence is the success state.
    expect(sessionConfigNotice(state({ stale: false }))).toEqual({ kind: 'hidden' });
  });

  test('loading is hidden, never a premature verdict', () => {
    expect(sessionConfigNotice(undefined)).toEqual({ kind: 'hidden' });
  });

  test('a sleeping sandbox is hidden — nothing is running the wrong config', () => {
    expect(
      sessionConfigNotice(
        state({ stale: null, sandbox_reachable: false, running_etag: null, latest_etag: null }),
      ),
    ).toEqual({ kind: 'hidden' });
  });

  test('a v1 project is hidden — the concept does not apply, so inventing a problem is wrong', () => {
    // kortix.toml compiles to nothing. `stale` is null forever for these, and a
    // warning here would be unfixable by design.
    expect(
      sessionConfigNotice(
        state({ stale: null, latest_etag: null, running_etag: null, sandbox_reachable: true }),
      ),
    ).toEqual({ kind: 'hidden' });
  });

  test('a live box that reports no etag stays quiet instead of presenting an unverifiable error', () => {
    expect(
      sessionConfigNotice(
        state({ stale: null, running_etag: null, latest_etag: 'new1new1new1new1' }),
      ),
    ).toEqual({ kind: 'hidden' });
  });

  test('NO input ever yields a positive "up to date" state', () => {
    // The regression that would gut this feature: some branch collapsing a null
    // into reassurance. There is no such kind in the union, and this asserts no
    // combination can produce one.
    const combos: SessionConfigState[] = [];
    for (const stale of [true, false, null] as const)
      for (const reachable of [true, false])
        for (const latest of ['new1new1new1new1', null])
          for (const running of ['old0old0old0old0', null])
            combos.push(
              state({
                stale,
                sandbox_reachable: reachable,
                latest_etag: latest,
                running_etag: running,
              }),
            );

    const kinds = new Set(combos.map((c) => sessionConfigNotice(c).kind));
    expect([...kinds].sort()).toEqual(['hidden', 'stale']);
  });

  test('stale wins over every explanatory branch', () => {
    // If the server said stale, that is the answer even when the box then went
    // unreachable between the two reads inside the same response.
    expect(sessionConfigNotice(state({ stale: true, sandbox_reachable: false })).kind).toBe(
      'stale',
    );
  });
});

const release = (over: Partial<SessionConfigRelease>): SessionConfigRelease => ({
  mode: 'follow-base',
  source: 'release',
  running_release_id: 'r'.repeat(64),
  desired_release_id: 'r'.repeat(64),
  proven: true,
  fallback_reason: null,
  failed_release_id: null,
  ...over,
});

describe('sessionConfigNotice with a config release block', () => {
  test('current: the running release is the desired release, nothing renders', () => {
    expect(sessionConfigNotice(state({ stale: false, release: release({}) }))).toEqual({
      kind: 'hidden',
    });
  });

  test('update available: stale true keeps the existing stale notice', () => {
    expect(
      sessionConfigNotice(
        state({
          stale: true,
          release: release({ desired_release_id: 'd'.repeat(64) }),
        }),
      ),
    ).toEqual({ kind: 'stale', running: 'aaaaaaaaaaaaaaaa', latest: 'aaaaaaaaaaaaaaaa' });
  });

  test('update available without etags names the two release IDs, shortened', () => {
    // A capable daemon decides `stale` by release ID. The etags can be null.
    expect(
      sessionConfigNotice(
        state({
          stale: true,
          running_etag: null,
          latest_etag: null,
          release: release({
            running_release_id: '0123456789abcdef'.repeat(4),
            desired_release_id: 'fedcba9876543210'.repeat(4),
          }),
        }),
      ),
    ).toEqual({ kind: 'stale', running: '0123456789ab', latest: 'fedcba987654' });
  });

  test('session config: mode session-files shows the neutral chip', () => {
    expect(
      sessionConfigNotice(
        state({
          stale: false,
          release: release({
            mode: 'session-files',
            source: 'workspace',
            running_release_id: null,
            desired_release_id: null,
          }),
        }),
      ),
    ).toEqual({ kind: 'session-files' });
  });

  test('session config with unloaded edits: stale wins, so the reload is offered', () => {
    expect(
      sessionConfigNotice(
        state({ stale: true, release: release({ mode: 'session-files', source: 'workspace' }) }),
      ).kind,
    ).toBe('stale');
  });

  test('fallback: a set fallback_reason shows the reason and what serves now', () => {
    expect(
      sessionConfigNotice(
        state({
          stale: true,
          release: release({
            running_release_id: '0123456789abcdef'.repeat(4),
            desired_release_id: 'fedcba9876543210'.repeat(4),
            failed_release_id: 'fedcba9876543210'.repeat(4),
            fallback_reason: 'GET /agent did not list the default agent within 90 s',
          }),
        }),
      ),
    ).toEqual({
      kind: 'fallback',
      reason: 'GET /agent did not list the default agent within 90 s',
      source: 'release',
      servingReleaseId: '0123456789ab',
      failedReleaseId: 'fedcba987654',
    });
  });

  test('fallback wins over stale and over session-files', () => {
    // After a failed convergence the running release differs from the desired
    // one, so `stale` is true. Offering "update available" would retry a
    // release that just failed; the reason is the useful answer.
    for (const mode of ['follow-base', 'session-files'] as const) {
      expect(
        sessionConfigNotice(
          state({ stale: true, release: release({ mode, fallback_reason: 'extract failed' }) }),
        ).kind,
      ).toBe('fallback');
    }
  });

  test('fallback to the image default names no release', () => {
    expect(
      sessionConfigNotice(
        state({
          stale: null,
          release: release({
            source: 'image-default',
            running_release_id: null,
            failed_release_id: null,
            fallback_reason: 'no config dir on the base branch',
          }),
        }),
      ),
    ).toEqual({
      kind: 'fallback',
      reason: 'no config dir on the base branch',
      source: 'image-default',
      servingReleaseId: null,
      failedReleaseId: null,
    });
  });

  test('an empty fallback_reason is not a fallback', () => {
    expect(
      sessionConfigNotice(state({ stale: false, release: release({ fallback_reason: '' }) })).kind,
    ).toBe('hidden');
  });

  test('a response without release renders exactly as before for every legacy combination', () => {
    for (const stale of [true, false, null] as const) {
      const legacy = state({ stale });
      expect('release' in legacy).toBe(false);
      expect(sessionConfigNotice(legacy).kind).toBe(stale === true ? 'stale' : 'hidden');
    }
  });
});

describe('reloadResultTone', () => {
  const result = (over: Partial<SessionReloadResult>): SessionReloadResult => ({
    applied: true,
    previous_etag: null,
    etag: null,
    repo_refreshed: false,
    commit_sha: null,
    detail: 'Reloaded.',
    ...over,
  });

  test('a clean reload is a success', () => {
    expect(reloadResultTone(result({}))).toBe('success');
    expect(reloadResultTone(result({ release: release({}) }))).toBe('success');
  });

  test('kept-yours and unknown agent files stay warnings', () => {
    expect(reloadResultTone(result({ agent_files: 'kept-yours' }))).toBe('warning');
    expect(reloadResultTone(result({ agent_files: 'unknown' }))).toBe('warning');
  });

  test('a reload that ended on a fallback is an error, never a success', () => {
    expect(
      reloadResultTone(result({ release: release({ fallback_reason: 'proven check failed' }) })),
    ).toBe('error');
  });

  test('a not-applied reload is a warning', () => {
    expect(reloadResultTone(result({ applied: false }))).toBe('warning');
  });
});

describe('reloadNotAppliedCopy', () => {
  test('every known reason becomes a sentence, not the reason itself', () => {
    // Deliberately not asserting the copy avoids the reason as a SUBSTRING —
    // "This project has no compiled agent config to load." properly contains
    // its own reason and is good copy. What matters is that no branch returns
    // the bare fragment.
    const reasons = [
      'no reachable sandbox',
      'no active sandbox',
      'no compiled agent config',
      'sandbox has no service key',
      'no env snapshot',
      'agent config unchanged',
    ];
    for (const reason of reasons) {
      const copy = reloadNotAppliedCopy(reason);
      expect(copy).not.toBe(reason);
      expect(copy).not.toBe(reloadNotAppliedCopy('some unmapped reason'));
      expect(copy[0]).toBe(copy[0].toUpperCase());
      expect(copy.endsWith('.')).toBe(true);
    }
  });

  test('an unknown or absent reason falls back rather than leaking internals', () => {
    // One `reason` on this path is a raw thrown exception message, so the
    // default must never pass its input through.
    expect(reloadNotAppliedCopy('ENOENT: some internal explosion')).toBe(
      "Reload didn't apply. Try again in a moment.",
    );
    expect(reloadNotAppliedCopy(undefined)).toBe("Reload didn't apply. Try again in a moment.");
  });

  test('"unchanged" reads as success, because it is', () => {
    expect(reloadNotAppliedCopy('agent config unchanged')).toBe(
      'Already running the latest config.',
    );
  });
});

/**
 * Two mutation properties that are invisible in normal use and expensive when wrong.
 * Source-asserted: exercising them needs a QueryClientProvider + a real network
 * seam, and this hook's own value is the pure logic above.
 */
const HOOK_SOURCE = readFileSync(join(import.meta.dir, 'use-session-config-freshness.ts'), 'utf8');

describe('useReloadSessionConfig — the costly mistakes', () => {
  test('the web reload is config-only and cannot refresh workspace files', () => {
    const body = HOOK_SOURCE.split('const mutation = useMutation({')[1]?.split('\n  });')[0];
    expect(body).toContain('refresh_repo: false');
  });

  test('the reload mutation never retries', () => {
    // The app-wide default retries any non-4xx once. The API answers 503 at its
    // own 25s deadline WHILE the reload keeps running server-side, so the
    // "failure" that would trigger a retry is usually a reload in progress —
    // and the retry restarts opencode a second time, ending the turn the first
    // restart just permitted.
    const body = HOOK_SOURCE.split('const mutation = useMutation({')[1]?.split('\n  });')[0];
    expect(body).toBeTruthy();
    expect(body).toContain('retry: false');
  });

  test('busyReason is state, not derived from mutation.error', () => {
    // mutate() clears the previous error before starting, so a derived
    // busyReason would unmount the confirm dialog on the very click that
    // confirms it — vanishing with no sign anything happened, and making its
    // isPending prop unobservable.
    expect(HOOK_SOURCE).toContain('useState<ReloadBusyReason | null>(null)');
    expect(HOOK_SOURCE).not.toContain('busyReason: busyReasonOf(mutation.error)');
    expect(HOOK_SOURCE).toContain('clearBusy: () => setBusyReason(null)');
  });
});

/**
 * The staleness check is edge-triggered off window focus, and React Query will
 * NOT refetch on focus while the cached answer is still within `staleTime`.
 * That made the constant itself the bug: at 5 minutes, the ordinary flow — edit
 * an agent file in your editor, tab back to the session — showed nothing, and
 * only a full page reload surfaced the notice, because a reload discards the
 * cache rather than revalidating it.
 */
describe('the freshness answer expires fast enough to be re-asked on focus', () => {
  test('staleTime is short enough for an edit-and-return round trip', () => {
    // Editing a file and tabbing back takes far longer than this, so the focus
    // refetch always fires for the flow this feature exists to serve.
    expect(CONFIG_FRESHNESS_STALE_TIME_MS).toBeLessThanOrEqual(60_000);
  });

  test('but not so short that alt-tabbing becomes a git fetch per switch', () => {
    // Each check drops the project's git-mirror TTL, recompiles the manifest and
    // reaches into the sandbox. Zero would make focus a hot path.
    expect(CONFIG_FRESHNESS_STALE_TIME_MS).toBeGreaterThanOrEqual(10_000);
  });
});
