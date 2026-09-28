import { describe, expect, test } from 'bun:test';
import type { Connection } from '@kortix/sdk';
import {
  accountVisibility,
  connectorConnectionRows,
  newAccountAudienceFor,
  newAccountGrantees,
  newAccountLabelTaken,
  newAccountReady,
  type NewAccountDraft,
} from './connector-connections';

describe('the Add account draft', () => {
  const draft = (overrides: Partial<NewAccountDraft> = {}): NewAccountDraft => ({
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
    expect(newAccountLabelTaken(draft({ label: ' work ' }), rows)).toBe(true);
    // A shared account and a private one are different rows: no clash.
    expect(newAccountLabelTaken(draft({ label: 'Work', audience: 'project' }), rows)).toBe(false);
    expect(newAccountLabelTaken(draft({ label: 'team INBOX', audience: 'members' }), rows)).toBe(true);
    expect(newAccountLabelTaken(draft({ label: '' }), rows)).toBe(false);
  });

  test('ready needs a free name, and sharing needs the manage right and someone picked', () => {
    const can = { canManageConnections: true, accountId: 'acct' };
    expect(newAccountReady(draft({ label: 'Personal' }), rows, can)).toBe(true);
    expect(newAccountReady(draft({ label: '  ' }), rows, can)).toBe(false);
    expect(newAccountReady(draft({ label: 'work' }), rows, can)).toBe(false);
    expect(newAccountReady(draft({ label: 'Shared', audience: 'project' }), rows, can)).toBe(true);
    expect(
      newAccountReady(draft({ label: 'Shared', audience: 'project' }), rows, { ...can, canManageConnections: false }),
    ).toBe(false);
    expect(newAccountReady(draft({ label: 'Sales', audience: 'members' }), rows, can)).toBe(false);
    const picked = { memberIds: [], groupIds: ['g-1'] };
    expect(newAccountReady(draft({ label: 'Sales', audience: 'members', picked }), rows, can)).toBe(true);
    expect(
      newAccountReady(draft({ label: 'Sales', audience: 'members', picked }), rows, { ...can, accountId: null }),
    ).toBe(false);
  });

  test('the picked people and groups become user and group grantees', () => {
    expect(newAccountGrantees({ memberIds: ['u-1'], groupIds: ['g-1'] })).toEqual([
      { type: 'user', id: 'u-1' },
      { type: 'group', id: 'g-1' },
    ]);
  });

  test('the link owner preselects the audience, and only a manager can start on everyone', () => {
    expect(newAccountAudienceFor('project', true)).toBe('project');
    expect(newAccountAudienceFor('project', false)).toBe('private');
    expect(newAccountAudienceFor('me', true)).toBe('private');
    expect(newAccountAudienceFor(undefined, true)).toBe('private');
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

  test('treats a missing list as empty, so the tab count never renders NaN', () => {
    expect(connectorConnectionRows(undefined, 'gmail')).toEqual([]);
  });
});

describe('accountVisibility', () => {
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
    expect(accountVisibility(account('member'), 'u-1')).toEqual({ kind: 'you' });
  });

  test('a shared account nobody narrowed is everyone', () => {
    expect(accountVisibility(account('project', []), 'u-1')).toEqual({ kind: 'everyone' });
  });

  test('a grant to the project is everyone, beside any other grant', () => {
    const shared = account('project', [share('group', 'sales', 'Sales'), share('project', 'p-1')]);
    expect(accountVisibility(shared, 'u-1')).toEqual({ kind: 'everyone' });
  });

  test('a shared account narrowed to the viewer alone is only you', () => {
    expect(accountVisibility(account('project', [share('member', 'u-1', 'me@x.test')]), 'u-1')).toEqual({
      kind: 'you',
    });
  });

  test('the same account seen by someone else names its one person', () => {
    expect(accountVisibility(account('project', [share('member', 'u-1', 'me@x.test')]), 'u-2')).toEqual({
      kind: 'named',
      names: ['me@x.test'],
      more: 0,
    });
  });

  test('groups lead, and the viewer comes last: "Sales +1", not their own address', () => {
    const shared = account('project', [share('member', 'u-1', 'me@x.test'), share('group', 'sales', 'Sales')]);
    expect(accountVisibility(shared, 'u-1')).toEqual({ kind: 'named', names: ['Sales'], more: 1 });
  });

  test('a narrowed account names its first grant and counts the rest', () => {
    const shared = account('project', [
      share('group', 'sales', 'Sales'),
      share('member', 'u-9', 'ada@x.test'),
      share('group', 'ops', 'Ops'),
    ]);
    expect(accountVisibility(shared, 'u-1')).toEqual({ kind: 'named', names: ['Sales'], more: 2 });
  });
});
