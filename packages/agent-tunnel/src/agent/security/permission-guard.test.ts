import { describe, expect, test } from 'bun:test';
import { PermissionGuard } from './permission-guard';

describe('PermissionGuard method binding', () => {
  test('does not let a valid permission id authorize another capability', () => {
    const guard = new PermissionGuard();
    guard.addPermission({
      permissionId: 'filesystem-permission',
      capability: 'filesystem',
      scope: {},
    });

    expect(guard.getPermissionForMethod('filesystem-permission', 'fs.read')).not.toBeNull();
    expect(guard.getPermissionForMethod('filesystem-permission', 'shell.exec')).toBeNull();
    expect(guard.getPermissionForMethod('filesystem-permission', 'desktop.cua.click')).toBeNull();
  });

  test('unknown methods fail closed', () => {
    const guard = new PermissionGuard();
    guard.addPermission({
      permissionId: 'filesystem-permission',
      capability: 'filesystem',
      scope: {},
    });
    expect(guard.getPermissionForMethod('filesystem-permission', 'fs.unknown')).toBeNull();
  });

  test('malformed server scopes fail closed on the machine', () => {
    const guard = new PermissionGuard();
    guard.syncPermissions([
      {
        permissionId: 'empty-commands',
        capability: 'shell',
        scope: { commands: [] },
      },
      {
        permissionId: 'unknown-field',
        capability: 'filesystem',
        scope: { path: '/tmp/secret' },
      },
      {
        permissionId: 'invalid-timeout',
        capability: 'shell',
        scope: { maxTimeout: Number.NaN },
      },
    ]);

    expect(guard.getPermissionForMethod('empty-commands', 'shell.exec')).toBeNull();
    expect(guard.getPermissionForMethod('unknown-field', 'fs.read')).toBeNull();
    expect(guard.getPermissionForMethod('invalid-timeout', 'shell.exec')).toBeNull();
  });
});
