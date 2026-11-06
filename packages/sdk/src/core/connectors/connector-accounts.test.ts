import { describe, expect, test } from 'bun:test';

import type { AdminConnector, Connection, ConnectionShare } from '../rest/projects-client';
import {
  type ConnectionAudienceSelection,
  type NewConnectorAccountDraft,
  connectorAccountNeedsSignIn,
  connectorAccountVisibility,
  connectorConnectionRows,
  emptyWorkspaceConnectionSlot,
  listedConnectorAccounts,
  newConnectorAccountAudienceFor,
  newConnectorAccountGrantees,
  newConnectorAccountLabelTaken,
  newConnectorAccountReady,
  planConnectionShare,
  planPrivateConnectionShare,
  proposeConnectorAccountLabel,
  connectionSharedWithEveryoneAfter,
} from './connector-accounts';

const EMPTY_SELECTION: ConnectionAudienceSelection = { memberIds: [], groupIds: [] };

describe('the Add account draft', () => {
  const draft = (overrides: Partial<NewConnectorAccountDraft> = {}): NewConnectorAccountDraft => ({
    label: 'Work',
    audience: 'private',
    picked: { memberIds: [], groupIds: [] },
    ...overrides,
  });
  const rows = [
    { label: 'Work', owner_type: 'member' },
    { label: 'Team inbox', owner_type: 'project' },
  ];

  test('a name the same owner already uses is taken, case- and space-insensitively', () => {
    expect(newConnectorAccountLabelTaken(draft({ label: ' work ' }), rows)).toBe(true);
    // A shared account and a private one are different rows: no clash.
    expect(newConnectorAccountLabelTaken(draft({ label: 'Work', audience: 'project' }), rows)).toBe(false);
    expect(newConnectorAccountLabelTaken(draft({ label: 'team INBOX', audience: 'members' }), rows)).toBe(
      true,
    );
    expect(newConnectorAccountLabelTaken(draft({ label: '' }), rows)).toBe(false);
  });

  test('ready needs a free name, and sharing needs the manage right and someone picked', () => {
    const can = { canManageConnections: true, accountId: 'acct' };
    expect(newConnectorAccountReady(draft({ label: 'Personal' }), rows, can)).toBe(true);
    expect(newConnectorAccountReady(draft({ label: '  ' }), rows, can)).toBe(false);
    expect(newConnectorAccountReady(draft({ label: 'work' }), rows, can)).toBe(false);
    expect(newConnectorAccountReady(draft({ label: 'Shared', audience: 'project' }), rows, can)).toBe(true);
    expect(
      newConnectorAccountReady(draft({ label: 'Shared', audience: 'project' }), rows, {
        ...can,
        canManageConnections: false,
      }),
    ).toBe(false);
    expect(newConnectorAccountReady(draft({ label: 'Sales', audience: 'members' }), rows, can)).toBe(false);
    const picked = { memberIds: [], groupIds: ['g-1'] };
    expect(newConnectorAccountReady(draft({ label: 'Sales', audience: 'members', picked }), rows, can)).toBe(
      true,
    );
    expect(
      newConnectorAccountReady(draft({ label: 'Sales', audience: 'members', picked }), rows, {
        ...can,
        accountId: null,
      }),
    ).toBe(false);
  });

  test('the picked people and groups become user and group grantees', () => {
    expect(newConnectorAccountGrantees({ memberIds: ['u-1'], groupIds: ['g-1'] })).toEqual([
      { type: 'user', id: 'u-1' },
      { type: 'group', id: 'g-1' },
    ]);
  });

  test('the link owner preselects the audience, and only a manager can start on everyone', () => {
    expect(newConnectorAccountAudienceFor('project', true)).toBe('project');
    expect(newConnectorAccountAudienceFor('project', false)).toBe('private');
    expect(newConnectorAccountAudienceFor('me', true)).toBe('private');
    expect(newConnectorAccountAudienceFor(undefined, true)).toBe('private');
  });
});

const connection = (connector_alias: string, owner_type: string, connection_id: string) => ({
  connector_alias,
  owner_type,
  connection_id,
});

describe('connectorConnectionRows', () => {
  test('keeps only the connector being viewed', () => {
    const rows = connectorConnectionRows(
      [connection('gmail', 'project', 'a'), connection('slack', 'project', 'b')],
      'gmail',
    );
    expect(rows.map((r) => r.connection_id)).toEqual(['a']);
  });

  test('keeps both project-owned and the caller’s own private connections', () => {
    const rows = connectorConnectionRows(
      [connection('gmail', 'project', 'project'), connection('gmail', 'member', 'mine')],
      'gmail',
    );
    expect(rows.map((r) => r.owner_type)).toEqual(['project', 'member']);
  });

  test('drops agent-owned connections, which are binding artifacts and not user connections', () => {
    const rows = connectorConnectionRows(
      [connection('gmail', 'agent', 'bound'), connection('gmail', 'project', 'project')],
      'gmail',
    );
    expect(rows.map((r) => r.connection_id)).toEqual(['project']);
  });

  test('drops disconnected (revoked) accounts: a disconnected account is gone', () => {
    const rows = connectorConnectionRows(
      [
        { ...connection('computer', 'member', 'unpaired'), status: 'revoked' },
        { ...connection('computer', 'member', 'live'), status: 'active' },
        { ...connection('computer', 'project', 'broken'), status: 'error' },
      ],
      'computer',
    );
    expect(rows.map((r) => r.connection_id)).toEqual(['live', 'broken']);
  });

  test('treats a missing list as empty, so the tab count never renders NaN', () => {
    expect(connectorConnectionRows(undefined, 'gmail')).toEqual([]);
  });
});

describe('connectorAccountVisibility', () => {
  const account = (
    owner_type: Connection['owner_type'],
    shared_with?: Connection['shared_with'],
  ): Connection => ({
    connection_id: 'c-1',
    connector_alias: 'crm',
    owner_type,
    owner_id: owner_type === 'member' ? 'u-1' : null,
    label: 'CRM',
    status: 'active',
    is_default: false,
    metadata: {},
    ...(shared_with ? { shared_with } : {}),
  });
  const share = (principal_type: 'member' | 'group' | 'project', id: string, label = id) => ({
    grant_id: `g-${id}`,
    principal_type,
    principal_id: id,
    label,
    expires_at: null,
  });

  test('your own account is only you', () => {
    expect(connectorAccountVisibility(account('member'), 'u-1')).toEqual({ kind: 'you' });
  });

  test('a shared account nobody narrowed is everyone', () => {
    expect(connectorAccountVisibility(account('project', []), 'u-1')).toEqual({ kind: 'everyone' });
  });

  test('a grant to the project is everyone, beside any other grant', () => {
    const shared = account('project', [share('group', 'sales', 'Sales'), share('project', 'p-1')]);
    expect(connectorAccountVisibility(shared, 'u-1')).toEqual({ kind: 'everyone' });
  });

  test('a shared account narrowed to the viewer alone is only you', () => {
    expect(
      connectorAccountVisibility(account('project', [share('member', 'u-1', 'me@x.test')]), 'u-1'),
    ).toEqual({
      kind: 'you',
    });
  });

  test('the same account seen by someone else names its one person', () => {
    expect(
      connectorAccountVisibility(account('project', [share('member', 'u-1', 'me@x.test')]), 'u-2'),
    ).toEqual({
      kind: 'named',
      names: ['me@x.test'],
      more: 0,
    });
  });

  test('groups lead, and the viewer comes last: "Sales +1", not their own address', () => {
    const shared = account('project', [
      share('member', 'u-1', 'me@x.test'),
      share('group', 'sales', 'Sales'),
    ]);
    expect(connectorAccountVisibility(shared, 'u-1')).toEqual({ kind: 'named', names: ['Sales'], more: 1 });
  });

  test('a narrowed account names its first grant and counts the rest', () => {
    const shared = account('project', [
      share('group', 'sales', 'Sales'),
      share('member', 'u-9', 'ada@x.test'),
      share('group', 'ops', 'Ops'),
    ]);
    expect(connectorAccountVisibility(shared, 'u-1')).toEqual({ kind: 'named', names: ['Sales'], more: 2 });
  });
});

// KRTX-2185: an MCP server with no sign-in (DeepWiki) listed its account as
// "Not signed in" with a Connect button. The API reports `authorized: false`
// for every account without a credential; a connector with no auth scheme
// has nothing to sign in.
describe('connectorAccountNeedsSignIn', () => {
  const unsigned = { authorized: false };
  test('a direct connector with no auth scheme has nothing to sign in', () => {
    expect(connectorAccountNeedsSignIn(unsigned, { provider: 'mcp', authSecret: null })).toBe(false);
    expect(connectorAccountNeedsSignIn(unsigned, { provider: 'openapi', authSecret: null })).toBe(false);
  });
  test('a direct connector with an auth scheme needs its sign-in', () => {
    expect(connectorAccountNeedsSignIn(unsigned, { provider: 'mcp', authSecret: 'LINEAR_TOKEN' })).toBe(true);
  });
  test('a managed account signs in through its provider, whatever authSecret says', () => {
    expect(connectorAccountNeedsSignIn(unsigned, { provider: 'composio', authSecret: null })).toBe(true);
  });
  test('a signed-in account, or an older server that sends no flag, needs nothing', () => {
    expect(connectorAccountNeedsSignIn({ authorized: true }, { provider: 'mcp', authSecret: 'X' })).toBe(false);
    expect(connectorAccountNeedsSignIn({}, { provider: 'mcp', authSecret: 'X' })).toBe(false);
  });
});

const slot = {
  connection_id: 'c-slot',
  connector_alias: 'github',
  owner_type: 'project',
  owner_id: null,
  label: 'GitHub',
  status: 'active',
  is_default: false,
  authorized: false,
  metadata: { default_slot: 'project' },
} as unknown as Connection;

const connector = (provider: string, requestAuthType: string) =>
  ({ slug: 'github', provider, requestAuthType }) as unknown as AdminConnector;

describe('emptyProjectConnectionSlot', () => {
  test('a managed app’s unsigned slot is the empty slot, though Composio holds its auth', () => {
    expect(emptyWorkspaceConnectionSlot(connector('composio', 'none'), [slot])).toBe(slot);
  });

  test('a direct connector that needs no credential has no empty slot: its account works', () => {
    expect(emptyWorkspaceConnectionSlot(connector('mcp', 'none'), [slot])).toBeNull();
  });

  test('a direct connector with an auth scheme has one', () => {
    expect(emptyWorkspaceConnectionSlot(connector('mcp', 'bearer'), [slot])).toBe(slot);
  });
});

describe('listedConnectorAccounts', () => {
  test('drops the empty shared slot and revoked rows, keeps the rest', () => {
    const mine = { ...slot, connection_id: 'c-mine', owner_type: 'member', metadata: {} } as unknown as Connection;
    const gone = { ...slot, connection_id: 'c-gone', status: 'revoked', metadata: {} } as unknown as Connection;
    const rows = listedConnectorAccounts([slot, mine, gone], connector('composio', 'none'));
    expect(rows.map((row) => row.connection_id)).toEqual(['c-mine']);
  });

  test('a direct connector with no credential lists its first account', () => {
    expect(listedConnectorAccounts([slot], connector('mcp', 'none')).map((row) => row.connection_id)).toEqual([
      'c-slot',
    ]);
  });
});

describe('proposeConnectorAccountLabel', () => {
  test('the first account takes the app name', () => {
    expect(proposeConnectorAccountLabel('Resend', [])).toBe('Resend');
  });
  test('later accounts are numbered past every taken label, whatever the case', () => {
    expect(proposeConnectorAccountLabel('Resend', ['resend'])).toBe('Resend 2');
    expect(proposeConnectorAccountLabel('Resend', ['Resend', 'Resend 2'])).toBe('Resend 3');
  });
});


const PROJECT = 'p-1';

const grant = (
  grant_id: string,
  principal_type: ConnectionShare['principal_type'],
  principal_id: string,
): ConnectionShare => ({ grant_id, principal_type, principal_id, label: principal_id, expires_at: null });

const pick = (overrides: Partial<ConnectionAudienceSelection>): ConnectionAudienceSelection => ({
  ...EMPTY_SELECTION,
  ...overrides,
});

const none = new Set<string>();

describe('planConnectionShare', () => {
  test('grants what is picked, in the canonical principal vocabulary', () => {
    expect(planConnectionShare([], none, pick({ memberIds: ['u-1'], groupIds: ['g-1'] }), PROJECT)).toEqual({
      add: [
        { type: 'user', id: 'u-1' },
        { type: 'group', id: 'g-1' },
      ],
      revoke: [],
    });
  });

  test('everyone in the project is the project principal, granted once', () => {
    expect(planConnectionShare([], none, pick({ everyone: true }), PROJECT).add).toEqual([
      { type: 'project', id: PROJECT },
    ]);
    const current = [grant('a-1', 'project', PROJECT)];
    expect(planConnectionShare(current, none, pick({ everyone: true }), PROJECT).add).toEqual([]);
  });

  test('a principal already granted is never granted twice', () => {
    const current = [grant('a-1', 'group', 'g-1')];
    expect(planConnectionShare(current, none, pick({ groupIds: ['g-1'] }), PROJECT)).toEqual({
      add: [],
      revoke: [],
    });
  });

  test('switching from one group to another grants the new one and revokes the old', () => {
    const current = [grant('a-1', 'group', 'sales')];
    expect(planConnectionShare(current, new Set(['a-1']), pick({ groupIds: ['support'] }), PROJECT)).toEqual({
      add: [{ type: 'group', id: 'support' }],
      revoke: ['a-1'],
    });
  });

  test('a grant removed and then picked again is left alone', () => {
    const current = [grant('a-1', 'member', 'u-1')];
    expect(planConnectionShare(current, new Set(['a-1']), pick({ memberIds: ['u-1'] }), PROJECT)).toEqual({
      add: [],
      revoke: [],
    });
  });
});

describe('connectionSharedWithEveryoneAfter', () => {
  test('an account nobody narrowed stays everyone', () => {
    expect(connectionSharedWithEveryoneAfter([], none, EMPTY_SELECTION)).toBe(true);
  });

  test('adding a group narrows it', () => {
    expect(connectionSharedWithEveryoneAfter([], none, pick({ groupIds: ['g-1'] }))).toBe(false);
  });

  test('removing the last narrowing grant widens it to everyone again', () => {
    const current = [grant('a-1', 'group', 'g-1')];
    expect(connectionSharedWithEveryoneAfter(current, none, EMPTY_SELECTION)).toBe(false);
    expect(connectionSharedWithEveryoneAfter(current, new Set(['a-1']), EMPTY_SELECTION)).toBe(true);
  });

  test('a grant to the project keeps it everyone, beside any group', () => {
    const current = [grant('a-1', 'group', 'g-1'), grant('a-2', 'project', PROJECT)];
    expect(connectionSharedWithEveryoneAfter(current, none, EMPTY_SELECTION)).toBe(true);
    expect(connectionSharedWithEveryoneAfter(current, new Set(['a-2']), EMPTY_SELECTION)).toBe(false);
  });

  test('only yourself is narrowed to you', () => {
    expect(connectionSharedWithEveryoneAfter([], none, pick({ memberIds: ['me'] }))).toBe(false);
  });
});

describe('planPrivateConnectionShare', () => {
  const OWNER = 'u-owner';

  test('nothing picked is nothing to do: the account stays yours', () => {
    expect(planPrivateConnectionShare(pick({}), true, OWNER)).toBeNull();
    expect(planPrivateConnectionShare(pick({}), false, OWNER)).toBeNull();
  });

  test('picked people and groups, and you unless you removed yourself', () => {
    expect(planPrivateConnectionShare(pick({ memberIds: ['u-1'], groupIds: ['g-1'] }), true, OWNER)).toEqual([
      { principal_type: 'user', principal_id: OWNER },
      { principal_type: 'user', principal_id: 'u-1' },
      { principal_type: 'group', principal_id: 'g-1' },
    ]);
    expect(planPrivateConnectionShare(pick({ groupIds: ['g-1'] }), false, OWNER)).toEqual([
      { principal_type: 'group', principal_id: 'g-1' },
    ]);
  });

  test('you are never listed twice', () => {
    expect(planPrivateConnectionShare(pick({ memberIds: [OWNER] }), true, OWNER)).toEqual([
      { principal_type: 'user', principal_id: OWNER },
    ]);
  });

  test('everyone in the project is the empty audience', () => {
    expect(planPrivateConnectionShare(pick({ everyone: true, groupIds: ['g-1'] }), true, OWNER)).toEqual([]);
  });
});
