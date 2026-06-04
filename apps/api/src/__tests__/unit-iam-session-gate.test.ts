// Pure unit coverage for evaluateSessionGate — the verdict matrix.

import { describe, expect, test } from 'bun:test';
import { evaluateSessionGate } from '../iam/session-gate';

const nowMs = 1_700_000_000_000;

describe('evaluateSessionGate', () => {
  test('no policy → allow', () => {
    expect(
      evaluateSessionGate({
        nowMs,
        iatSeconds: nowMs / 1000 - 60,
        maxLifetimeMinutes: null,
        idleTimeoutMinutes: null,
        lastSeenAt: null,
        revokedAt: null,
      }),
    ).toBe('allow');
  });

  test('revoked_at always wins', () => {
    expect(
      evaluateSessionGate({
        nowMs,
        iatSeconds: nowMs / 1000,
        maxLifetimeMinutes: 60,
        idleTimeoutMinutes: 60,
        lastSeenAt: new Date(nowMs - 1_000),
        revokedAt: new Date(nowMs - 10_000),
      }),
    ).toBe('revoked');
  });

  test('max lifetime exceeded', () => {
    // iat 2 hours ago, max 60 minutes
    expect(
      evaluateSessionGate({
        nowMs,
        iatSeconds: nowMs / 1000 - 2 * 60 * 60,
        maxLifetimeMinutes: 60,
        idleTimeoutMinutes: null,
        lastSeenAt: new Date(nowMs - 1_000),
        revokedAt: null,
      }),
    ).toBe('lifetime_exceeded');
  });

  test('max lifetime within bounds', () => {
    expect(
      evaluateSessionGate({
        nowMs,
        iatSeconds: nowMs / 1000 - 30 * 60, // 30 min ago
        maxLifetimeMinutes: 60,
        idleTimeoutMinutes: null,
        lastSeenAt: new Date(nowMs),
        revokedAt: null,
      }),
    ).toBe('allow');
  });

  test('max lifetime skipped when iat missing', () => {
    expect(
      evaluateSessionGate({
        nowMs,
        iatSeconds: null,
        maxLifetimeMinutes: 60,
        idleTimeoutMinutes: null,
        lastSeenAt: null,
        revokedAt: null,
      }),
    ).toBe('allow');
  });

  test('idle timeout exceeded', () => {
    expect(
      evaluateSessionGate({
        nowMs,
        iatSeconds: nowMs / 1000,
        maxLifetimeMinutes: null,
        idleTimeoutMinutes: 15,
        lastSeenAt: new Date(nowMs - 30 * 60 * 1000),
        revokedAt: null,
      }),
    ).toBe('idle_timeout');
  });

  test('idle timeout skipped when no lastSeenAt (first sight)', () => {
    expect(
      evaluateSessionGate({
        nowMs,
        iatSeconds: nowMs / 1000,
        maxLifetimeMinutes: null,
        idleTimeoutMinutes: 5,
        lastSeenAt: null,
        revokedAt: null,
      }),
    ).toBe('allow');
  });

  test('lifetime checked before idle', () => {
    expect(
      evaluateSessionGate({
        nowMs,
        iatSeconds: nowMs / 1000 - 24 * 60 * 60, // 24h
        maxLifetimeMinutes: 60,
        idleTimeoutMinutes: 5,
        lastSeenAt: new Date(nowMs - 24 * 60 * 60 * 1000),
        revokedAt: null,
      }),
    ).toBe('lifetime_exceeded');
  });
});
