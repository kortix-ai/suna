import {
  capabilityForMethod,
  isTunnelCapability,
  validateTunnelPermissionScope,
} from '../../shared/permissions';

/**
 * Permission Guard — local-side permission enforcement (defense in depth).
 *
 * Even though the server validates permissions before relaying RPCs,
 * the local agent also checks permissions as a second layer of defense.
 * This prevents a compromised server from bypassing permission controls.
 *
 * After the initial permission sync, unknown permissionIds are denied.
 * Before sync, unknown IDs are also denied (fail-closed).
 */

export interface LocalPermission {
  permissionId: string;
  capability: string;
  scope: Record<string, unknown>;
  expiresAt?: string;
}

export class PermissionGuard {
  private permissions = new Map<string, LocalPermission>();

  /** Bulk-load permissions from server sync notification. */
  syncPermissions(permissions: LocalPermission[]): void {
    this.permissions.clear();
    for (const perm of permissions) {
      this.addPermission(perm);
    }
  }

  addPermission(permission: LocalPermission): void {
    if (
      typeof permission?.permissionId !== 'string' ||
      !permission.permissionId ||
      !isTunnelCapability(permission.capability) ||
      !validateTunnelPermissionScope(permission.capability, permission.scope).valid
    ) {
      if (typeof permission?.permissionId === 'string') {
        this.permissions.delete(permission.permissionId);
      }
      return;
    }
    this.permissions.set(permission.permissionId, permission);
  }

  revokePermission(permissionId: string): void {
    this.permissions.delete(permissionId);
  }

  checkPermission(permissionId: string | undefined): boolean {
    return !!this.getPermission(permissionId);
  }

  getPermission(permissionId: string | undefined): LocalPermission | null {
    if (!permissionId) {
      return null;
    }

    const perm = this.permissions.get(permissionId);
    if (!perm) {
      // After sync, unknown permission = deny (fail-closed).
      // Before sync, also deny — we have no basis to allow.
      return null;
    }

    if (perm.expiresAt) {
      const expiry = new Date(perm.expiresAt).getTime();
      if (isNaN(expiry) || expiry < Date.now()) {
        this.permissions.delete(permissionId);
        return null;
      }
    }

    return perm;
  }

  getPermissionForMethod(permissionId: string | undefined, method: string): LocalPermission | null {
    const permission = this.getPermission(permissionId);
    const requiredCapability = capabilityForMethod(method);
    if (!permission || !requiredCapability || permission.capability !== requiredCapability) {
      return null;
    }
    return permission;
  }

  clear(): void {
    this.permissions.clear();
  }
}
