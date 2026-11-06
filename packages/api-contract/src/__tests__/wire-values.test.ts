import { describe, expect, test } from 'bun:test';
import { SessionLogStatusEventSchema } from '../session-log/events';
import { RUNTIME_CAPABILITIES as RELAY_RUNTIME_CAPABILITIES } from '../runtime-relay';
import { SessionPromptSchema } from '../index';
import type { KortixSessionStatus } from '../transcript';
import type { RuntimeThreadStatus } from '../runtime-relay';
import {
  CREDIT_ACCOUNT_PAYMENT_STATUSES,
  RUNTIME_CAPABILITIES,
  SESSION_CONTROL_FRAME_TYPES,
  SESSION_PROMPT_REASONS,
  SESSION_START_RESUMING_REASONS,
  SESSION_START_TRANSPORT_REASONS,
  SESSION_STREAM_FRAME_TYPES,
  THREAD_STATUSES,
  isParkedRuntimeDownReason,
  isThreadWorking,
  toKortixSessionStatusType,
  toRuntimeThreadStatus,
  type KortixSessionStatusType,
  type ThreadStatus,
} from '../wire-values';

/** `true` only when A and B are the same set of literals. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('thread status: one base set, two documented projections', () => {
  test('log.status carries the base set', () => {
    expect(SessionLogStatusEventSchema.shape.status.options).toEqual([...THREAD_STATUSES]);
  });

  test('the pending projection reports retry as busy', () => {
    const projected = THREAD_STATUSES.map(toRuntimeThreadStatus);
    expect(projected).toEqual(['idle', 'busy', 'busy', 'compacting']);
  });

  test('the v1 session.status projection reports compacting as busy', () => {
    const projected = THREAD_STATUSES.map(toKortixSessionStatusType);
    expect(projected).toEqual(['idle', 'busy', 'retry', 'busy']);
  });

  test('every status except idle is work', () => {
    expect(THREAD_STATUSES.filter(isThreadWorking)).toEqual(['busy', 'retry', 'compacting']);
  });

  test('the wire types are the projections (typecheck target)', () => {
    const pending: Same<RuntimeThreadStatus, Exclude<ThreadStatus, 'retry'>> = true;
    const v1: Same<KortixSessionStatus['type'], KortixSessionStatusType> = true;
    const v1Projection: Same<KortixSessionStatusType, Exclude<ThreadStatus, 'compacting'>> = true;
    expect([pending, v1, v1Projection]).toEqual([true, true, true]);
  });
});

test('runtime-relay re-exports the one capability list', () => {
  expect(RELAY_RUNTIME_CAPABILITIES).toBe(RUNTIME_CAPABILITIES);
  expect(RUNTIME_CAPABILITIES).toContain('session.steer');
});

test('the session stream frame types are disjoint and kortix-prefixed', () => {
  const all = [...SESSION_CONTROL_FRAME_TYPES, ...SESSION_STREAM_FRAME_TYPES];
  expect(new Set(all).size).toBe(all.length);
  for (const type of all) expect(type.startsWith('kortix.')).toBe(true);
  expect(SESSION_STREAM_FRAME_TYPES).toContain('kortix.stream.revoked');
});

test('a down runtime is parked only for a sandbox row reason', () => {
  expect(isParkedRuntimeDownReason('sandbox_stopped')).toBe(true);
  expect(isParkedRuntimeDownReason('sandbox_archived')).toBe(true);
  expect(isParkedRuntimeDownReason('no_sandbox')).toBe(true);
  expect(isParkedRuntimeDownReason('daemon_503')).toBe(false);
  expect(isParkedRuntimeDownReason('runtime_stream_stalled')).toBe(false);
  expect(isParkedRuntimeDownReason(null)).toBe(false);
});

test('a transport start reason is also a resuming reason, never a lifecycle one', () => {
  for (const reason of SESSION_START_TRANSPORT_REASONS.filter((r) => r !== 'unreachable')) {
    expect(SESSION_START_RESUMING_REASONS as readonly string[]).toContain(reason);
  }
});

test('a prompt reason outside the set fails the prompt schema', () => {
  const reason = SessionPromptSchema.shape.reason;
  for (const value of SESSION_PROMPT_REASONS) expect(reason.safeParse(value).success).toBe(true);
  expect(reason.safeParse(null).success).toBe(true);
  expect(reason.safeParse('not_a_reason').success).toBe(false);
});

test('the payment status set holds every value the billing writers store', () => {
  expect([...CREDIT_ACCOUNT_PAYMENT_STATUSES].sort()).toEqual(['active', 'cancelling', 'deleted', 'failed', 'past_due']);
});
