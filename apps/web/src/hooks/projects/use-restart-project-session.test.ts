import { sessionStartKey } from '@kortix/sdk';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { restartFailureMessage, restartPendingStartSeed } from './use-restart-project-session';

/**
 * `apps/web` has no jsdom/happy-dom and no `@testing-library/react` (see
 * `features/workspace/settings/tabs/general-tab.rename.test.tsx`), so a
 * restart click cannot be rendered or driven here. The coverage is split the
 * same way as the rename pair:
 *
 * - this file pins what the shared hook's helpers DO against a real
 *   QueryClient, plus a source scan of the hook itself that pins the
 *   `onMutate`/`onSuccess`/`onError` wiring — the scan is the half a
 *   helpers-in-isolation test cannot see, because a silent revert of
 *   `onMutate` to a local no-op still passes a helper-only test;
 * - `features/session/session-starting-loader.test.tsx` scans the loader
 *   surfaces and pins that BOTH restart buttons wire this hook (and only this
 *   hook), so every surface inherits the seed + rollback behavior proven here.
 */

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const PROJECT = 'proj_restart_1';
const SESSION = 'sess_restart_1';

const source = readFileSync(join(import.meta.dir, 'use-restart-project-session.ts'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// The scan reads the whole comment-stripped hook: every asserted line lives
// only in its single `useMutation` block, so a full-file scan cannot match
// anywhere else.
const mutationCount = code.split('useMutation({').length - 1;

describe('restartPendingStartSeed — the optimistic /start payload', () => {
  test('seeds a fresh provisioning boot that every /start consumer can read', () => {
    expect(restartPendingStartSeed()).toEqual({
      stage: 'provisioning',
      retriable: true,
      sandbox: null,
      runtime_session_id: null,
      opencode_session_id: null,
      reason: 'restart_requested',
    });
  });

  test('is writable and readable under the real /start cache key', () => {
    const qc = client();
    const key = sessionStartKey(PROJECT, SESSION);
    qc.setQueryData(key, restartPendingStartSeed());
    expect(qc.getQueryData(key)).toEqual(restartPendingStartSeed());
  });
});

describe('restartFailureMessage', () => {
  test('passes the real rejection message through', () => {
    expect(restartFailureMessage(new Error('SESSION_RUNTIME_IDENTITY_UNAVAILABLE'))).toBe(
      'SESSION_RUNTIME_IDENTITY_UNAVAILABLE',
    );
  });

  test('falls back to one sentence for an empty or non-Error rejection', () => {
    expect(restartFailureMessage(new Error('   '))).toBe('Restart failed. Try again in a moment.');
    expect(restartFailureMessage('boom')).toBe('Restart failed. Try again in a moment.');
    expect(restartFailureMessage(undefined)).toBe('Restart failed. Try again in a moment.');
  });
});

describe('the hook wires the full restart behavior — the source the component runs', () => {
  test('the scan found the single restart mutation', () => {
    expect(mutationCount).toBe(1);
    expect(code).toContain('mutationFn: () => restartProjectSession(projectId, sessionId),');
  });

  test('onMutate seeds the /start cache and snapshots it for rollback', () => {
    expect(code).toContain('const previous = queryClient.getQueryData(startKey);');
    expect(code).toContain('queryClient.setQueryData(startKey, restartPendingStartSeed());');
    expect(code).toContain('return { previous };');
  });

  test('onSuccess refreshes everything a restart invalidates', () => {
    expect(code).toContain('clearRuntimeEnsureGuard();');
    expect(code).toContain('resetRuntimeQueries(queryClient);');
    expect(code).toContain('queryClient.invalidateQueries({ queryKey: startKey });');
    expect(code).toContain('qk.project.sessionSandbox(projectId, sessionId)');
    expect(code).toContain('qk.project.sessionsScope(projectId)');
  });

  test('onError rolls the optimistic seed back before toasting', () => {
    // A rejected restart must put the pre-click /start data back (else the
    // boot loader spins forever on a session that never restarted) or, when
    // nothing was cached, invalidate so the real state refetches.
    expect(code).toContain('queryClient.setQueryData(startKey, context.previous);');
    expect(code).toContain("queryClient.invalidateQueries({ queryKey: startKey });");
    expect(code).toContain('errorToast(restartFailureMessage(error));');
  });
});
