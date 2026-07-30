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
      },
      now,
    );

    expect(metadata.runtimeWakeStartedAt).toBe(now.toISOString());
    expect(metadata.runtimeWakeProviderStatus).toBe('starting');
    expect(metadata.opencodeReadyWaitStartedAt).toBeUndefined();
    expect(metadata.opencodeReadyWaitReason).toBeUndefined();
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
