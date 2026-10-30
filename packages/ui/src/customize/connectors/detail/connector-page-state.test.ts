import { describe, expect, test } from 'bun:test';

import { connectHandoff, connectorPageState } from './connector-page-state';

const settled = { found: false, isPending: false, isFetching: false, isError: false };

describe('connectorPageState', () => {
  test('a found connector is ready, even while the list refetches', () => {
    expect(connectorPageState({ ...settled, found: true, isFetching: true })).toBe('ready');
  });
  test('a cold page is loading', () => {
    expect(connectorPageState({ ...settled, isPending: true })).toBe('loading');
  });
  test('a just-installed connector is loading until the refetch lands', () => {
    // Install invalidates the list and navigates. The cached list is stale and
    // does not hold the new connector yet.
    expect(connectorPageState({ ...settled, isFetching: true })).toBe('loading');
  });
  test('a failed list is an error, not a missing connector', () => {
    expect(connectorPageState({ ...settled, isError: true })).toBe('error');
  });
  test('only a settled list declares the connector missing', () => {
    expect(connectorPageState(settled)).toBe('missing');
  });
});

describe('connectHandoff', () => {
  const mine = { connection_id: 'conn-mine', owner_type: 'member' };
  const shared = { connection_id: 'conn-shared', owner_type: 'project' };
  /** A settled, already-refetched list read by someone who may manage shared accounts. */
  const base = {
    accounts: [mine, shared],
    settled: true,
    refetched: true,
    canManageConnections: true,
    direct: true,
  };

  test('no connect id does nothing', () => {
    expect(connectHandoff({ ...base, connectId: null })).toEqual({ action: 'none' });
  });
  test("an id among this connector's accounts opens credential entry", () => {
    expect(connectHandoff({ ...base, connectId: 'conn-mine' })).toEqual({
      action: 'open',
      connectionId: 'conn-mine',
      owner: 'me',
    });
  });
  test('a found id opens before the list has settled or been refetched', () => {
    expect(
      connectHandoff({ ...base, connectId: 'conn-mine', settled: false, refetched: false }).action,
    ).toBe('open');
  });
  test('the owner comes from the row, never from the URL', () => {
    // The input has no URL owner at all: a project row is `project`, any other
    // row is `me`.
    expect(connectHandoff({ ...base, connectId: 'conn-shared' })).toEqual({
      action: 'open',
      connectionId: 'conn-shared',
      owner: 'project',
    });
  });
  test('a just-created account waits while the list is fetching', () => {
    expect(
      connectHandoff({ ...base, connectId: 'conn-new', settled: false, refetched: false }),
    ).toEqual({ action: 'wait' });
  });
  test('a fresh cache that lacks the id asks for one refetch before discarding', () => {
    expect(connectHandoff({ ...base, connectId: 'conn-new', refetched: false })).toEqual({
      action: 'refetch',
    });
  });
  test('after the refetch a missing id is discarded', () => {
    expect(connectHandoff({ ...base, connectId: 'conn-new', refetched: true })).toEqual({
      action: 'discard',
    });
  });
  test('found after the refetch opens', () => {
    const created = { connection_id: 'conn-new', owner_type: 'member' };
    expect(connectHandoff({ ...base, accounts: [mine, created], connectId: 'conn-new' })).toEqual({
      action: 'open',
      connectionId: 'conn-new',
      owner: 'me',
    });
  });
  test('an id that belongs to another connector is discarded', () => {
    // `accounts` holds only this connector's rows, so another connector's
    // connection is absent from the refetched list.
    expect(connectHandoff({ ...base, connectId: 'conn-other-connector' })).toEqual({
      action: 'discard',
    });
  });
  test('a project account does not open for someone who may not manage connections', () => {
    // Same gate as the account row, which offers "Set credential" on a project
    // account only to a connections manager.
    expect(
      connectHandoff({ ...base, connectId: 'conn-shared', canManageConnections: false }),
    ).toEqual({ action: 'discard' });
  });
  test('a project account waits while the manage right is still loading', () => {
    // `canManageConnections` is false until its probe answers; `settled` covers it.
    expect(
      connectHandoff({
        ...base,
        connectId: 'conn-shared',
        canManageConnections: false,
        settled: false,
      }),
    ).toEqual({ action: 'wait' });
  });
  test('a member-owned account opens without the manage right', () => {
    expect(
      connectHandoff({ ...base, connectId: 'conn-mine', canManageConnections: false }),
    ).toEqual({ action: 'open', connectionId: 'conn-mine', owner: 'me' });
  });
  test('a managed connector never opens static-credential entry', () => {
    // Same rule as the account row: "Set credential" exists only on a direct
    // provider. A managed account is authorized through its provider window.
    expect(connectHandoff({ ...base, connectId: 'conn-mine', direct: false })).toEqual({
      action: 'discard',
    });
  });
  test('a managed connector discards without waiting for the list', () => {
    expect(
      connectHandoff({
        ...base,
        connectId: 'conn-new',
        direct: false,
        settled: false,
        refetched: false,
      }),
    ).toEqual({ action: 'discard' });
  });
});
