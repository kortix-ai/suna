import { describe, expect, test } from 'bun:test';
import { selectBindableConnections } from '../../src/server/bindable-connections';

const connection = (over: Record<string, unknown> = {}) =>
  ({
    connection_id: 'p1',
    connector_alias: 'gmail',
    owner_type: 'workspace',
    owner_id: null,
    label: 'Support',
    status: 'active',
    is_default: false,
    metadata: {},
    ...over,
  }) as never;

describe('selectBindableConnections', () => {
  test('offers workspace connections for the requested connector', () => {
    const rows = selectBindableConnections([connection()], 'gmail');
    expect(rows.map((r) => r.label)).toEqual(['Support']);
  });

  test('never offers a member PRIVATE connection', () => {
    // A wrapper has no personal identity upstream, so binding one is impossible
    // — offering it would produce a create failure the user cannot act on.
    const rows = selectBindableConnections(
      [connection({ owner_type: 'member', owner_id: 'u1' })],
      'gmail',
    );
    expect(rows).toHaveLength(0);
  });

  test("never offers another wrapper's external connection", () => {
    expect(
      selectBindableConnections([connection({ owner_type: 'external', owner_id: 'x' })], 'gmail'),
    ).toHaveLength(0);
  });

  test('drops revoked and errored connections', () => {
    // These bind "successfully" and then fail at the first tool call.
    expect(selectBindableConnections([connection({ status: 'revoked' })], 'gmail')).toHaveLength(0);
    expect(selectBindableConnections([connection({ status: 'error' })], 'gmail')).toHaveLength(0);
  });

  test('ignores other connectors', () => {
    expect(selectBindableConnections([connection({ connector_alias: 'slack' })], 'gmail')).toHaveLength(
      0,
    );
  });

  test('puts the default first — it is what an unbound alias resolves to anyway', () => {
    const rows = selectBindableConnections(
      [
        connection({ connection_id: 'a', label: 'Aaa' }),
        connection({ connection_id: 'b', label: 'Zzz', is_default: true }),
      ],
      'gmail',
    );
    expect(rows.map((r) => r.label)).toEqual(['Zzz', 'Aaa']);
  });

  test('sorts the rest by label so the order never flickers', () => {
    const rows = selectBindableConnections(
      [connection({ connection_id: 'b', label: 'Bbb' }), connection({ connection_id: 'a', label: 'Aaa' })],
      'gmail',
    );
    expect(rows.map((r) => r.label)).toEqual(['Aaa', 'Bbb']);
  });

  test('no connections is empty, not a crash', () => {
    expect(selectBindableConnections(undefined, 'gmail')).toEqual([]);
  });
});
