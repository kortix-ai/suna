import type { Connection } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import type { TunnelConnection } from '@/hooks/tunnel/use-tunnel';
import type { DesktopComputerStatus } from '@/lib/desktop';
import {
  computerDisplayName,
  computerState,
  groupOwnedComputers,
  platformName,
  projectComputerAccounts,
  yourComputerMenu,
} from './computer-connect';
import { activeGrant, capabilitiesNeedingSetup } from './local-computer-modal';

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
    expect(
      computerState(local({ serviceActive: false, paused: false, state: 'offline' }), false),
    ).toBe('offline');
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
    expect(
      activeGrant({ mode: 'always', grantedUntil: '2026-09-29T11:00:00.000Z' }, now),
    ).toBeNull();
  });
});

describe('computerDisplayName', () => {
  test('prefers the machine’s own friendly name while the name is still the hostname', () => {
    expect(
      computerDisplayName('MacBook-Pro-9.local', {
        hostname: 'MacBook-Pro-9.local',
        displayName: 'Ada’s MacBook Pro',
      }),
    ).toBe('Ada’s MacBook Pro');
  });

  test('keeps a name the owner chose', () => {
    expect(
      computerDisplayName('Studio', {
        hostname: 'MacBook-Pro-9.local',
        displayName: 'Ada’s MacBook Pro',
      }),
    ).toBe('Studio');
  });

  test('falls back to the hostname without .local (older agents report no displayName)', () => {
    expect(computerDisplayName('MacBook-Pro-9.local', { hostname: 'MacBook-Pro-9.local' })).toBe(
      'MacBook-Pro-9',
    );
    expect(computerDisplayName('build-box', null)).toBe('build-box');
    expect(computerDisplayName(undefined, {})).toBe('');
  });
});

test('platformName names the three desktop platforms and nothing else', () => {
  expect(platformName('darwin')).toBe('macOS');
  expect(platformName('win32')).toBe('Windows');
  expect(platformName('linux')).toBe('Linux');
  expect(platformName('freebsd')).toBeNull();
  expect(platformName(undefined)).toBeNull();
});

describe('yourComputerMenu', () => {
  const live = { isLive: true };
  const down = { isLive: false };

  test('a paired desktop opens its own machine, with its own state', () => {
    expect(
      yourComputerMenu({ tunnelId: 't-1', state: 'paused', oneClickHere: true, owned: [down] }),
    ).toEqual({ dialog: 'this', dot: 'paused' });
  });

  test('a browser with paired machines lists them; the dot is online when any is', () => {
    expect(yourComputerMenu({ oneClickHere: false, owned: [down, live] })).toEqual({
      dialog: 'mine',
      dot: 'online',
    });
    expect(yourComputerMenu({ oneClickHere: false, owned: [down] })).toEqual({
      dialog: 'mine',
      dot: 'offline',
    });
  });

  test('a browser with nothing paired opens the connect dialog', () => {
    expect(yourComputerMenu({ oneClickHere: false, owned: [] })).toEqual({
      dialog: 'connect',
      dot: null,
    });
  });

  test('a desktop that can pair itself opens "Your computer" (Connect, and My Capture), with no dot', () => {
    expect(yourComputerMenu({ oneClickHere: true, owned: [live] })).toEqual({ dialog: 'this', dot: null });
    expect(yourComputerMenu({ oneClickHere: true, owned: [] })).toEqual({ dialog: 'this', dot: null });
  });
});

test('capabilitiesNeedingSetup: a capability waits on the macOS grants it needs', () => {
  expect(capabilitiesNeedingSetup(undefined)).toEqual([]);
  expect(capabilitiesNeedingSetup([])).toEqual([]);
  expect(capabilitiesNeedingSetup(['files'])).toEqual(['filesystem']);
  expect(capabilitiesNeedingSetup(['screenRecording'])).toEqual(['desktop']);
  expect(capabilitiesNeedingSetup(['files', 'accessibility', 'screenRecording'])).toEqual([
    'filesystem',
    'desktop',
  ]);
});

describe('groupOwnedComputers', () => {
  const machine = (tunnelId: string, over: Partial<TunnelConnection> = {}): TunnelConnection =>
    ({
      tunnelId,
      name: tunnelId,
      isLive: false,
      lastHeartbeatAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      machineInfo: {},
      capabilities: [],
      ...over,
    }) as TunnelConnection;
  const hw = (id: string) => ({ machineId: id.repeat(64) });

  test('one entry per hardware, live first, then most recently seen', () => {
    const { computers, older } = groupOwnedComputers([
      machine('old-same-hw', { machineInfo: hw('a'), lastHeartbeatAt: '2026-08-01T00:00:00.000Z' }),
      machine('other-hw', { machineInfo: hw('b'), lastHeartbeatAt: '2026-09-01T00:00:00.000Z' }),
      machine('live-same-hw', { machineInfo: hw('a'), isLive: true }),
    ]);
    expect(computers.map((m) => m.tunnelId)).toEqual(['live-same-hw', 'other-hw']);
    expect(older).toEqual([]);
  });

  test('a registration without a hardware id is an older connection unless it is online now', () => {
    const { computers, older } = groupOwnedComputers([
      machine('legacy-offline-1', { lastHeartbeatAt: '2026-08-09T00:00:00.000Z' }),
      machine('legacy-online', { isLive: true }),
      machine('legacy-offline-2', { lastHeartbeatAt: '2026-08-13T00:00:00.000Z' }),
    ]);
    expect(computers.map((m) => m.tunnelId)).toEqual(['legacy-online']);
    expect(older.map((m) => m.tunnelId)).toEqual(['legacy-offline-2', 'legacy-offline-1']);
  });
});
