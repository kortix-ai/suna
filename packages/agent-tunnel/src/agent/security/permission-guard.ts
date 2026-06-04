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
  private hasSynced = false;

  /** Bulk-load permissions from server sync notification. */
  syncPermissions(permissions: LocalPermission[]): void {
    this.permissions.clear();
    for (const perm of permissions) {
      this.permissions.set(perm.permissionId, perm);
    }
    this.hasSynced = true;
  }

  addPermission(permission: LocalPermission): void {
    this.permissions.set(permission.permissionId, permission);
  }

  revokePermission(permissionId: string): void {
    this.permissions.delete(permissionId);
  }

  checkPermission(permissionId: string | undefined): boolean {
    if (!permissionId) {
      return false;
    }

    const perm = this.permissions.get(permissionId);
    if (!perm) {
      // After sync, unknown permission = deny (fail-closed).
      // Before sync, also deny — we have no basis to allow.
      return false;
    }

    if (perm.expiresAt) {
      const expiry = new Date(perm.expiresAt).getTime();
      if (isNaN(expiry) || expiry < Date.now()) {
        this.permissions.delete(permissionId);
        return false;
      }
    }

    return true;
  }

  clear(): void {
    this.permissions.clear();
    this.hasSynced = false;
  }
}
