export type ProjectRole = 'manager' | 'editor' | 'viewer';
export type AccountRole = 'owner' | 'admin' | 'member';
export type ProjectAccessAction = 'read' | 'write' | 'manage';

export function isAccountManager(role: AccountRole): boolean {
  return role === 'owner' || role === 'admin';
}

export function roleAllows(role: ProjectRole | null, action: ProjectAccessAction): boolean {
  if (!role) return false;
  if (action === 'read') return true;
  if (action === 'write') return role === 'editor' || role === 'manager';
  return role === 'manager';
}

export function effectiveProjectRole(
  accountRole: AccountRole,
  projectRole: ProjectRole | null,
): ProjectRole | null {
  if (isAccountManager(accountRole)) return 'manager';
  return projectRole;
}

export function parseProjectRole(value: unknown): ProjectRole | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized === 'manager' || normalized === 'editor' || normalized === 'viewer'
    ? normalized
    : null;
}
