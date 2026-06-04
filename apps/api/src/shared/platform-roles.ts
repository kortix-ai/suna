import { platformUserRoles } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db, hasDatabase } from './db';

export type PlatformRole = 'user' | 'admin' | 'super_admin';

export async function getPlatformRole(accountId: string): Promise<PlatformRole> {
  if (!hasDatabase) {
    return 'user';
  }

  const [row] = await db
    .select({ role: platformUserRoles.role })
    .from(platformUserRoles)
    .where(eq(platformUserRoles.accountId, accountId))
    .limit(1);

  if (row?.role === 'admin' || row?.role === 'super_admin') {
    return row.role;
  }

  return 'user';
}

export async function isPlatformAdmin(accountId: string): Promise<boolean> {
  const role = await getPlatformRole(accountId);
  return role === 'admin' || role === 'super_admin';
}
