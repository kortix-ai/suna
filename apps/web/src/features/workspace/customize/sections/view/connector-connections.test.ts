import { describe, expect, test } from 'bun:test';
import { connectorConnectionRows } from './connector-connections';

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
