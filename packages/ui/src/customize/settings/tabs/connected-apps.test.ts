import { describe, expect, test } from 'bun:test';
import type { OAuthGrant } from '@kortix/sdk';

import { connectedAppMetaParts } from './connected-apps';

const grant = (over: Partial<OAuthGrant>): OAuthGrant => ({
  client_id: 'kortix_client_1',
  name: 'Claude Code',
  client_type: 'public',
  self_registered: true,
  redirect_hosts: ['127.0.0.1:33418'],
  scopes: ['kortix'],
  granted_at: '2026-09-01T00:00:00.000Z',
  last_active_at: '2026-09-28T10:00:00.000Z',
  active: true,
  ...over,
});

const copy = {
  lastActive: (time: string) => `Active ${time}`,
  approved: (time: string) => `Approved ${time}`,
  relativeTime: (iso: string) => iso.slice(0, 10),
};

describe('connectedAppMetaParts', () => {
  test('names where the app signs in, then when it was last active', () => {
    expect(connectedAppMetaParts(grant({}), copy)).toEqual(['127.0.0.1:33418', 'Active 2026-09-28']);
  });

  test('an app that never got a token shows when it was approved', () => {
    expect(connectedAppMetaParts(grant({ last_active_at: null }), copy)).toEqual(['127.0.0.1:33418', 'Approved 2026-09-01']);
  });
});
