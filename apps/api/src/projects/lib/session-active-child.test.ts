import { describe, expect, test } from 'bun:test';
import type { SessionWorking } from '@kortix/api-contract';

import { activeChildAgents, type ChildRow } from './session-active-child';

const working: SessionWorking = { state: 'working', since: null, turn_token: null, pending_delivery: false };
const idle: SessionWorking = { state: 'idle', since: null, turn_token: null, pending_delivery: false };
const child = (sessionId: string, parentSessionId: string, agentName: string | null, minute: number): ChildRow => ({
  sessionId,
  parentSessionId,
  agentName,
  updatedAt: new Date(Date.UTC(2026, 10, 4, 21, minute)),
});

describe('a thread’s active child agent', () => {
  test('the newest working child per thread names the agent; idle and nameless children do not', () => {
    const rows = [
      child('c1', 't1', 'worker', 1),
      child('c2', 't1', 'researcher', 5),
      child('c3', 't2', 'worker', 3),
      child('c4', 't3', null, 4),
    ];
    const states = new Map([
      ['c1', working],
      ['c2', working],
      ['c3', idle],
      ['c4', working],
    ]);
    expect(Object.fromEntries(activeChildAgents(rows, states))).toEqual({ t1: 'researcher' });
  });

  test('no working child: no entry', () => {
    expect(activeChildAgents([child('c1', 't1', 'worker', 1)], new Map()).size).toBe(0);
  });
});
