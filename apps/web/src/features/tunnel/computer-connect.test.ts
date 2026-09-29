import type { Connection } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { myComputerAccounts } from './computer-connect';

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

describe('myComputerAccounts', () => {
  test('keeps only the caller’s own active computer accounts', () => {
    const mine = connection({ connection_id: 'mine' });
    const rows = [
      mine,
      connection({ connection_id: 'shared', owner_type: 'project', owner_id: null }),
      connection({ connection_id: 'theirs', owner_id: OTHER }),
      connection({ connection_id: 'revoked', status: 'revoked' }),
      connection({ connection_id: 'gmail', tunnel_id: null }),
    ];
    expect(myComputerAccounts(rows, ME)).toEqual([mine]);
  });

  test('is empty while signed out', () => {
    expect(myComputerAccounts([connection({})], null)).toEqual([]);
  });
});
