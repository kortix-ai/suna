/**
 * A tunnel permission that expires is an access change, so it is audited.
 *
 * The tunnel cleanup job flips `active` permissions past `expires_at` to
 * `expired` every 5 minutes. That revoked a computer capability silently:
 * no audit row said which grant ended or when.
 */
import { describe, expect, test } from 'bun:test';
import type { AuditEventInput } from '../shared/audit';
import { expireTunnelPermissions } from './permission-expiry';

const ACCOUNT = '00000000-0000-4000-a000-000000000101';
const TUNNEL = '00000000-0000-4000-a000-000000000301';

describe('expireTunnelPermissions', () => {
  test('each permission it expires writes one access-change row on its tunnel', async () => {
    const recorded: AuditEventInput[] = [];
    const now = new Date('2026-09-24T08:00:00.000Z');
    const expired = await expireTunnelPermissions(now, {
      expire: async (at) => {
        expect(at).toBe(now);
        return [
          { permissionId: 'perm-1', tunnelId: TUNNEL, accountId: ACCOUNT, capability: 'filesystem', expiresAt: new Date('2026-09-24T07:59:00.000Z') },
          { permissionId: 'perm-2', tunnelId: TUNNEL, accountId: ACCOUNT, capability: 'shell', expiresAt: null },
        ];
      },
      record: async (event) => {
        recorded.push(event);
      },
    });

    expect(expired).toBe(2);
    expect(recorded).toEqual([
      {
        accountId: ACCOUNT,
        action: 'connector.computer.permission.expired',
        resourceType: 'computer_tunnel',
        resourceId: TUNNEL,
        outcome: 'success',
        before: { status: 'active' },
        after: { status: 'expired' },
        metadata: { permission_id: 'perm-1', capability: 'filesystem', expires_at: '2026-09-24T07:59:00.000Z' },
      },
      {
        accountId: ACCOUNT,
        action: 'connector.computer.permission.expired',
        resourceType: 'computer_tunnel',
        resourceId: TUNNEL,
        outcome: 'success',
        before: { status: 'active' },
        after: { status: 'expired' },
        metadata: { permission_id: 'perm-2', capability: 'shell', expires_at: null },
      },
    ]);
  });

  test('nothing expired writes nothing', async () => {
    const recorded: AuditEventInput[] = [];
    const expired = await expireTunnelPermissions(new Date(), {
      expire: async () => [],
      record: async (event) => {
        recorded.push(event);
      },
    });
    expect(expired).toBe(0);
    expect(recorded).toEqual([]);
  });

  test('a failed audit write does not undo or stop the expiry of the rest', async () => {
    const recorded: string[] = [];
    const expired = await expireTunnelPermissions(new Date(), {
      expire: async () => [
        { permissionId: 'a', tunnelId: TUNNEL, accountId: ACCOUNT, capability: 'shell', expiresAt: null },
        { permissionId: 'b', tunnelId: TUNNEL, accountId: ACCOUNT, capability: 'shell', expiresAt: null },
      ],
      record: async (event) => {
        const id = (event.metadata as { permission_id: string }).permission_id;
        if (id === 'a') throw new Error('audit queue full');
        recorded.push(id);
      },
    });
    expect(expired).toBe(2);
    expect(recorded).toEqual(['b']);
  });
});
