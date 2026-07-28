import { describe, expect, test } from 'bun:test';
import { connectorConnectionRows } from './connector-connections';

const profile = (connector_alias: string, owner_type: string, profile_id: string) => ({
  connector_alias,
  owner_type,
  profile_id,
});

describe('connectorConnectionRows', () => {
  test('keeps only the connector being viewed', () => {
    const rows = connectorConnectionRows(
      [profile('gmail', 'project', 'a'), profile('slack', 'project', 'b')],
      'gmail',
    );
    expect(rows.map((r) => r.profile_id)).toEqual(['a']);
  });

  test('keeps both team-shared and the caller’s own private connections', () => {
    const rows = connectorConnectionRows(
      [profile('gmail', 'project', 'team'), profile('gmail', 'member', 'mine')],
      'gmail',
    );
    expect(rows.map((r) => r.owner_type)).toEqual(['project', 'member']);
  });

  test('drops agent-owned profiles, which are a binding artifact and not a connection', () => {
    const rows = connectorConnectionRows(
      [profile('gmail', 'agent', 'bound'), profile('gmail', 'project', 'team')],
      'gmail',
    );
    expect(rows.map((r) => r.profile_id)).toEqual(['team']);
  });

  test('treats a missing list as empty, so the tab count never renders NaN', () => {
    expect(connectorConnectionRows(undefined, 'gmail')).toEqual([]);
  });
});
