import type { Connection } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import type { DesktopComputerStatus } from '@/lib/desktop';
import { computerState, projectComputerAccounts } from './computer-connect';
import { activeGrant } from './local-computer-modal';

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

const connection = (over: Partial<Connection>): Connection =>
  ({
    connection_id: 'c-1',
    connector_alias: 'computer',
    label: 'Laptop',
    owner_type: 'member',
    owner_id: ME,
    status: 'active',
    is_default: false,
    tunnel_id: 't-1',
    ...over,
  }) as Connection;

describe('projectComputerAccounts', () => {
  test('keeps the caller’s own and the project-shared active computer accounts', () => {
    const mine = connection({ connection_id: 'mine' });
    const shared = connection({ connection_id: 'shared', owner_type: 'project', owner_id: null });
    const rows = [
      mine,
      shared,
      connection({ connection_id: 'theirs', owner_id: OTHER }),
      connection({ connection_id: 'revoked', status: 'revoked' }),
      connection({ connection_id: 'gmail', tunnel_id: null }),
    ];
    expect(projectComputerAccounts(rows, ME)).toEqual([mine, shared]);
  });

  test('is empty while signed out', () => {
    expect(projectComputerAccounts([connection({})], null)).toEqual([]);
  });
});

describe('computerState', () => {
  const local = (over: Partial<DesktopComputerStatus>): DesktopComputerStatus => ({
    available: true,
    paired: true,
    tunnelId: 't-1',
    serviceInstalled: true,
    serviceActive: true,
    ...over,
  });

  test('the relay heartbeat wins: a live machine is online', () => {
    expect(computerState(local({ state: 'offline', paused: false }), true)).toBe('online');
  });

  test('a paused machine reads paused, even while the relay still lists it live', () => {
    expect(computerState(local({ paused: true, serviceActive: false }), true)).toBe('paused');
  });

  test('a stopped service that is not paused reads offline (the desktop app repairs it)', () => {
    expect(computerState(local({ serviceActive: false, paused: false, state: 'offline' }), false)).toBe('offline');
  });

  test('a rejected credential needs a reconnect', () => {
    expect(computerState(local({ state: 'rejected', paused: false }), false)).toBe(
      'needsReconnect',
    );
  });

  test('a local agent still dialing in, or standing by, is connecting', () => {
    expect(computerState(local({ state: 'connecting', paused: false }), false)).toBe('connecting');
    expect(computerState(local({ state: 'standby', paused: false }), false)).toBe('connecting');
    expect(computerState(local({ state: 'online', paused: false }), false)).toBe('connecting');
  });

  test('otherwise offline', () => {
    expect(computerState(local({ state: 'offline', paused: false }), false)).toBe('offline');
  });
});

describe('activeGrant', () => {
  const now = Date.parse('2026-09-29T10:00:00.000Z');

  test('an approval that has not run out is the current grant', () => {
    expect(activeGrant({ mode: 'ask', grantedUntil: '2026-09-29T11:00:00.000Z' }, now)).toEqual(
      new Date('2026-09-29T11:00:00.000Z'),
    );
  });

  test('an expired approval, no approval, or another mode is none', () => {
    expect(activeGrant({ mode: 'ask', grantedUntil: '2026-09-29T09:00:00.000Z' }, now)).toBeNull();
    expect(activeGrant({ mode: 'ask', grantedUntil: null }, now)).toBeNull();
    expect(activeGrant({ mode: 'always', grantedUntil: '2026-09-29T11:00:00.000Z' }, now)).toBeNull();
  });
});
