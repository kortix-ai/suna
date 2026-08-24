import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  prepareInPlaceRestartMetadata,
  staleOpencodeReadyReason,
} from '../projects/session-lifecycle/readiness-clocks';

const source = readFileSync(
  new URL('../projects/session-lifecycle/actions.ts', import.meta.url),
  'utf8',
);

describe('session restart URL contract', () => {
  test('clears sandboxUrl only when a replacement runtime is required', () => {
    const replacementStart = source.indexOf('const provisionReplacementRuntime');
    const inPlaceStart = source.indexOf('if (\n    existingSandbox?.externalId');

    expect(replacementStart).toBeGreaterThan(-1);
    expect(inPlaceStart).toBeGreaterThan(replacementStart);
    expect(source.slice(replacementStart, inPlaceStart)).toContain('sandboxUrl: null');
    expect(source.slice(inPlaceStart)).not.toContain('sandboxUrl: null');
  });

  test('starts a fresh runtime clock and removes stale OpenCode clocks', () => {
    const now = new Date('2026-07-24T02:00:00.000Z');
    const metadata = prepareInPlaceRestartMetadata(
      {
        initSucceededAt: '2026-07-24T01:00:00.000Z',
        opencodeReadyWaitStartedAt: '2026-07-24T01:00:00.000Z',
        opencodeReadyWaitReason: 'unreachable',
        opencodeUnreachableWaitStartedAt: '2026-07-24T01:00:00.000Z',
        opencodeNotReadyWaitStartedAt: '2026-07-24T01:30:00.000Z',
      },
      now,
    );

    expect(metadata.runtimeWakeStartedAt).toBe(now.toISOString());
    expect(metadata.runtimeWakeProviderStatus).toBe('starting');
    expect(metadata.opencodeReadyWaitStartedAt).toBeUndefined();
    expect(metadata.opencodeReadyWaitReason).toBeUndefined();
    expect(metadata.opencodeUnreachableWaitStartedAt).toBeUndefined();
    expect(metadata.opencodeNotReadyWaitStartedAt).toBeUndefined();
  });

  test('tracks unreachable and not-ready deadlines independently across reason changes', () => {
    const metadata = {
      opencodeReadyWaitStartedAt: '2026-07-24T01:59:59.000Z',
      opencodeReadyWaitReason: 'not_ready',
      opencodeUnreachableWaitStartedAt: '2026-07-24T01:59:29.000Z',
      opencodeNotReadyWaitStartedAt: '2026-07-24T01:58:29.000Z',
    };
    const now = Date.parse('2026-07-24T02:00:00.000Z');

    expect(staleOpencodeReadyReason(metadata, 'unreachable', now, 30_000)).toBe(
      'runtime_unreachable_timeout',
    );
    expect(staleOpencodeReadyReason(metadata, 'not_ready', now, 90_000)).toBe(
      'runtime_not_ready_timeout',
    );
  });

  test('does not treat an old initial boot as a stale post-restart OpenCode wait', () => {
    expect(
      staleOpencodeReadyReason(
        { initSucceededAt: '2026-07-24T01:00:00.000Z' },
        'unreachable',
        Date.parse('2026-07-24T02:00:00.000Z'),
      ),
    ).toBeNull();

    expect(
      staleOpencodeReadyReason(
        { opencodeReadyWaitStartedAt: '2026-07-24T01:54:59.000Z' },
        'unreachable',
        Date.parse('2026-07-24T02:00:00.000Z'),
      ),
    ).toBe('runtime_unreachable_timeout');
  });
});
