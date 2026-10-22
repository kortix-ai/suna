import { describe, expect, test } from 'bun:test';

import type { SessionStartResult } from '../core/rest/projects-client';
import { holdLiveStart, liveStartPollMode } from './hold-live-start';

function sandbox(id: string, status = 'active') {
  return {
    sandbox_id: id,
    session_id: id,
    project_id: 'p',
    account_id: 'a',
    provider: 'platinum',
    external_id: `sbx_${id}`,
    base_url: null,
    status,
    config: {},
    metadata: {},
    last_used_at: null,
    created_at: '2026-09-29T00:00:00Z',
    updated_at: '2026-09-29T00:00:00Z',
  } as unknown as NonNullable<SessionStartResult['sandbox']>;
}

const ready: SessionStartResult = {
  stage: 'ready',
  agent_name: 'default',
  retriable: false,
  sandbox: sandbox('s1'),
  opencode_session_id: 'ses_1',
  runtime_url: '/p/sbx_s1/8000',
  reason: 'unchanged',
};

function starting(reason: string, box: SessionStartResult['sandbox'] = sandbox('s1')): SessionStartResult {
  return { ...ready, stage: 'starting', retriable: true, sandbox: box, opencode_session_id: null, reason };
}

describe('holdLiveStart — a live session leaves live only on a lifecycle fact', () => {
  test('a failed /start poll (null) keeps the live answer', () => {
    expect(holdLiveStart(ready, null)).toBe(ready);
  });

  test('a probe timeout on the same running box keeps the live answer', () => {
    expect(holdLiveStart(ready, starting('unreachable'))).toBe(ready);
    expect(holdLiveStart(ready, starting('unreachable', null))).toBe(ready);
    expect(holdLiveStart(ready, starting('runtime_status_unknown', null))).toBe(ready);
    expect(holdLiveStart(ready, starting('runtime_stop_unconfirmed', null))).toBe(ready);
  });

  test('a new ready answer replaces the held one', () => {
    const next = { ...ready, opencode_session_id: 'ses_2' };
    expect(holdLiveStart(ready, next)).toBe(next);
  });

  test('lifecycle facts leave live', () => {
    const waking = starting('runtime_waking', null);
    expect(holdLiveStart(ready, waking)).toBe(waking);
    const relaunch = starting('runtime_updating');
    expect(holdLiveStart(ready, relaunch)).toBe(relaunch);
    const stopped = { ...ready, stage: 'stopped' as const, sandbox: null };
    expect(holdLiveStart(ready, stopped)).toBe(stopped);
    const failed = { ...ready, stage: 'failed' as const };
    expect(holdLiveStart(ready, failed)).toBe(failed);
  });

  test('a different sandbox, or the same sandbox no longer active, leaves live', () => {
    const moved = starting('unreachable', sandbox('s2'));
    expect(holdLiveStart(ready, moved)).toBe(moved);
    const parked = starting('unreachable', sandbox('s1', 'stopped'));
    expect(holdLiveStart(ready, parked)).toBe(parked);
  });

  test('before the session was ever live, every answer passes through', () => {
    const boot = starting('unreachable');
    expect(holdLiveStart(undefined, boot)).toBe(boot);
    expect(holdLiveStart(starting('not_ready'), boot)).toBe(boot);
    expect(holdLiveStart(undefined, null)).toBeNull();
  });
});

describe('liveStartPollMode — a keep-alive poll never wakes or reads for nobody (05#1)', () => {
  test('a ready tab that is in the foreground polls with keep_stopped', () => {
    expect(liveStartPollMode(ready, false)).toBe('keep-stopped');
  });

  test('a ready tab in the background does not poll at all', () => {
    expect(liveStartPollMode(ready, true)).toBe('skip');
  });

  test('every other state is an open: it may wake, and a wake in flight is finished in the background', () => {
    expect(liveStartPollMode(null, false)).toBe('open');
    expect(liveStartPollMode(undefined, true)).toBe('open');
    expect(liveStartPollMode(starting('runtime_waking', null), true)).toBe('open');
    expect(liveStartPollMode({ ...ready, stage: 'stopped' as const, sandbox: null }, false)).toBe('open');
  });
});
