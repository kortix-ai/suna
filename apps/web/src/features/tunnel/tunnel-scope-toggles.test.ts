import { describe, expect, test } from 'bun:test';
import { buildActiveScopeMap } from './tunnel-scope-toggles';
import type { TunnelPermission } from '@/hooks/tunnel/use-tunnel';

function permission(partial: Partial<TunnelPermission>): TunnelPermission {
  return {
    permissionId: partial.permissionId ?? crypto.randomUUID(),
    tunnelId: 'tnl_1',
    accountId: 'acct_1',
    capability: partial.capability ?? 'filesystem',
    scope: partial.scope ?? {},
    status: partial.status ?? 'active',
    expiresAt: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

describe('buildActiveScopeMap', () => {
  test('uses explicit scope markers for granular grants', () => {
    const map = buildActiveScopeMap([
      permission({
        permissionId: 'perm_read',
        capability: 'filesystem',
        scope: { scope: 'files:read', operations: ['read', 'list'] },
      }),
    ]);

    expect(map.get('files:read')).toBe('perm_read');
    expect(map.has('files:write')).toBe(false);
  });

  test('treats legacy broad capability grants as active for that capability group', () => {
    const map = buildActiveScopeMap([
      permission({ permissionId: 'perm_desktop', capability: 'desktop', scope: {} }),
    ]);

    expect(map.get('desktop:computer_use')).toBe('perm_desktop');
    expect(map.get('desktop:apps')).toBe('perm_desktop');
    expect(map.get('desktop:observe')).toBe('perm_desktop');
    expect(map.get('desktop:input')).toBe('perm_desktop');
    expect(map.has('shell:exec')).toBe(false);
  });
});
