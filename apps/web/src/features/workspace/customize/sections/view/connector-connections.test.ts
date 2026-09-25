import { describe, expect, test } from 'bun:test';
import type { Connection } from '@kortix/sdk';
import { connectorConnectionRows, sharedAudienceSummary } from './connector-connections';

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

describe('sharedAudienceSummary', () => {
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
  const share = (principal_type: 'member' | 'group' | 'project', label: string) => ({
    grant_id: `g-${label}`,
    principal_type,
    principal_id: label,
    label,
    expires_at: null,
  });

  test('a private account has no audience line', () => {
    expect(sharedAudienceSummary(account('member'))).toBeNull();
  });

  test('a shared account nobody narrowed is everyone', () => {
    expect(sharedAudienceSummary(account('project', []))).toEqual({ kind: 'everyone' });
  });

  test('a narrowed account names its first two grants and counts the rest', () => {
    const summary = sharedAudienceSummary(
      account('project', [share('group', 'Sales'), share('member', 'ada@x.test'), share('group', 'Ops')]),
    );
    expect(summary).toEqual({ kind: 'narrowed', names: ['Sales', 'ada@x.test'], more: 1 });
  });
});
