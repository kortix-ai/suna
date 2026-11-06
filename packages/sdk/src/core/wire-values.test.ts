import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as sdk from '../index';
import type { RuntimeCapability, RuntimeThreadStatus } from '../index';
import type { KortixSessionStatus } from './runtime/transcript-types';
import type * as C from '../../../api-contract/src/wire-values';

/** Everything from the first declaration on: the part both copies must share. */
function body(file: string): string {
  const text = readFileSync(file, 'utf8');
  return text.slice(text.indexOf('export const THREAD_STATUSES'));
}

test('the SDK wire value sets equal the api-contract copy', () => {
  const vendored = body(join(import.meta.dir, 'wire-values.ts'));
  const contract = body(join(import.meta.dir, '../../../api-contract/src/wire-values.ts'));
  expect(vendored.length).toBeGreaterThan(3000);
  expect(vendored).toBe(contract);
});

/** `true` only when A and B are the same set of literals. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

test('the SDK public types are the contract sets (typecheck target)', () => {
  const capabilities: Same<RuntimeCapability, C.RuntimeCapability> = true;
  const pending: Same<RuntimeThreadStatus, C.RuntimeThreadStatus> = true;
  const v1: Same<KortixSessionStatus['type'], C.KortixSessionStatusType> = true;
  expect([capabilities, pending, v1]).toEqual([true, true, true]);
});

test('runtimeSupports takes every contract capability, session.steer included', () => {
  const caps = ['session.subagents', 'session.steer'];
  expect(sdk.runtimeSupports(caps, 'session.steer')).toBe(true);
  expect(sdk.runtimeSupports(caps, 'session.team_tasks')).toBe(false);
  expect(sdk.RUNTIME_CAPABILITIES).toContain('session.log.v2');
});

test('the SDK root exports the value sets and their decisions', () => {
  expect(sdk.THREAD_STATUSES).toEqual(['idle', 'busy', 'retry', 'compacting']);
  expect(sdk.toKortixSessionStatusType('compacting')).toBe('busy');
  expect(sdk.toRuntimeThreadStatus('retry')).toBe('busy');
  expect(sdk.SESSION_CONTROL_FRAME_TYPES).toContain('kortix.control.turn');
  expect(sdk.SESSION_STREAM_FRAME_TYPES).toContain('kortix.stream.revoked');
  expect(sdk.isParkedRuntimeDownReason('sandbox_stopped')).toBe(true);
  expect(sdk.isSessionStartTransportReason('runtime_status_unknown')).toBe(true);
  expect(sdk.isSessionPromptReason('held')).toBe(true);
  expect(sdk.CREDIT_ACCOUNT_PAYMENT_STATUSES).toContain('cancelling');
});
