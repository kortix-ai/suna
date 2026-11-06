import { describe, expect, test } from 'bun:test';
import { resolveSessionRouteSurface, type SessionRouteSurfaceInput } from './session-terminal-state';

const NONE: SessionRouteSurfaceInput = {
  sessionSwitchLoading: false,
  gated: false,
  sessionMissing: false,
  sandboxArchived: false,
  repositoryDisconnected: false,
  wakeLadderHolding: false,
  hasRecoverableFailure: false,
  dormantWithoutRuntime: false,
  legacyMigrated: false,
  runtimeIdentityUnavailable: false,
  previousRepositoryHistoryAvailable: false,
  fatal: false,
  autoResuming: false,
  hasTranscript: false,
  showCachedTranscriptWhileDown: false,
};

const resolve = (patch: Partial<SessionRouteSurfaceInput>) => resolveSessionRouteSurface({ ...NONE, ...patch });

describe('resolveSessionRouteSurface', () => {
  test('no terminal fact: the chat, no notice', () => {
    expect(resolve({})).toEqual({ screen: null, notice: null });
  });

  test('precedence: switch-loading > billing-gated > missing > everything else', () => {
    const all = { gated: true, sessionMissing: true, sandboxArchived: true, fatal: true };
    expect(resolve({ ...all, sessionSwitchLoading: true }).screen).toBe('switch-loading');
    expect(resolve(all).screen).toBe('billing-gated');
    expect(resolve({ sessionMissing: true, sandboxArchived: true, fatal: true }).screen).toBe('missing');
  });

  // `archived` was named by no predicate: it fell through to the boot
  // overlay or the chat.
  test('an archived sandbox gets its own card, or a notice over a transcript', () => {
    expect(resolve({ sandboxArchived: true })).toEqual({ screen: 'archived', notice: null });
    expect(resolve({ sandboxArchived: true, hasTranscript: true, fatal: true, showCachedTranscriptWhileDown: false }))
      .toEqual({ screen: 'stopped', notice: null });
    expect(resolve({ sandboxArchived: true, hasTranscript: true, showCachedTranscriptWhileDown: true })).toEqual({
      screen: null,
      notice: 'archived',
    });
  });

  test('archived outranks a start failure and a lost runtime', () => {
    expect(resolve({ sandboxArchived: true, hasRecoverableFailure: true, runtimeIdentityUnavailable: true }).screen).toBe(
      'archived',
    );
  });

  test('repository disconnected: card without a transcript, notice with one', () => {
    expect(resolve({ repositoryDisconnected: true }).screen).toBe('repository-disconnected');
    expect(resolve({ repositoryDisconnected: true, hasTranscript: true })).toEqual({
      screen: null,
      notice: 'repository-disconnected',
    });
  });

  test('the wake ladder holds the boot surface over a failure, unless a transcript may render', () => {
    expect(resolve({ wakeLadderHolding: true, hasRecoverableFailure: true }).screen).toBe('waking');
    expect(resolve({ wakeLadderHolding: true, hasRecoverableFailure: true, hasTranscript: true, showCachedTranscriptWhileDown: true }))
      .toEqual({ screen: null, notice: null });
  });

  test('a start failure: card, or a notice that blocks the lower terminal checks', () => {
    expect(resolve({ hasRecoverableFailure: true }).screen).toBe('start-failure');
    expect(resolve({ hasRecoverableFailure: true, hasTranscript: true, runtimeIdentityUnavailable: true, dormantWithoutRuntime: true }))
      .toEqual({ screen: null, notice: 'start-failure' });
  });

  test('dormant: legacy restore card or notice; a plain stop keeps the chat when readable', () => {
    expect(resolve({ dormantWithoutRuntime: true, legacyMigrated: true }).screen).toBe('legacy-dormant');
    expect(resolve({ dormantWithoutRuntime: true, legacyMigrated: true, hasTranscript: true }).notice).toBe('legacy-dormant');
    expect(resolve({ dormantWithoutRuntime: true }).screen).toBe('stopped-dormant');
    expect(resolve({ dormantWithoutRuntime: true, hasTranscript: true })).toEqual({ screen: null, notice: null });
  });

  test('runtime lost: only without a previous repository history', () => {
    expect(resolve({ runtimeIdentityUnavailable: true }).screen).toBe('runtime-lost');
    expect(resolve({ runtimeIdentityUnavailable: true, hasTranscript: true }).notice).toBe('runtime-lost');
    expect(resolve({ runtimeIdentityUnavailable: true, previousRepositoryHistoryAvailable: true })).toEqual({
      screen: null,
      notice: null,
    });
  });

  test('fatal: the auto-resume loader or the Restart card, vetoed by a renderable transcript', () => {
    expect(resolve({ fatal: true, autoResuming: true }).screen).toBe('auto-resuming');
    expect(resolve({ fatal: true }).screen).toBe('stopped');
    expect(resolve({ fatal: true, hasTranscript: true, showCachedTranscriptWhileDown: true })).toEqual({
      screen: null,
      notice: null,
    });
  });
});
