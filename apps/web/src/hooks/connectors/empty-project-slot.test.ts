import { describe, expect, test } from 'bun:test';
import type { AdminConnector, Connection } from '@kortix/sdk';

import { emptyProjectSlot } from '@kortix/ui/internal/hooks/connectors/use-add-account';

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

describe('emptyProjectSlot', () => {
  test('a managed app’s unsigned slot is the empty slot, though Composio holds its auth', () => {
    expect(emptyProjectSlot(connector('composio', 'none'), [slot])).toBe(slot);
  });

  test('a direct connector that needs no credential has no empty slot: its account works', () => {
    expect(emptyProjectSlot(connector('mcp', 'none'), [slot])).toBeNull();
  });

  test('a direct connector with an auth scheme has one', () => {
    expect(emptyProjectSlot(connector('mcp', 'bearer'), [slot])).toBe(slot);
  });
});
