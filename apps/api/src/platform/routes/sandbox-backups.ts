import { Hono } from 'hono';
import { type Database } from '@kortix/db';
import { db as defaultDb } from '../../shared/db';
import { supabaseAuth as authMiddleware } from '../../middleware/auth';
import { resolveAccountId as defaultResolveAccountId } from '../../shared/resolve-account';
import { JustAVPSProvider } from '../providers/justavps';
import { getProvider as defaultGetProvider, type ProviderName, type SandboxProvider } from '../providers';
import type { AuthVariables } from '../../types';
import { findAccessibleSandboxForUser } from '../services/sandbox-access';

interface BackupRouterDeps {
  db: Database;
  getProvider: (name: ProviderName) => SandboxProvider;
  resolveAccountId: (userId: string) => Promise<string>;
  useAuth: boolean;
}

const defaultDeps: BackupRouterDeps = {
  db: defaultDb,
  getProvider: defaultGetProvider,
  resolveAccountId: defaultResolveAccountId,
  useAuth: true,
};

async function requireAccessibleJustavpsSandbox(
  db: Database,
  userId: string,
  sandboxId: string,
  getProvider: (name: ProviderName) => SandboxProvider,
  resolveAccountId: (userId: string) => Promise<string>,
) {
  const { sandbox, access } = await findAccessibleSandboxForUser({
    db,
    userId,
    sandboxId,
    resolveAccountId,
  });

  if (!sandbox) return { error: 'Sandbox not found', status: 404 as const };
  const isOwner =
    access.isPlatformAdmin || access.ownerAccountIds.includes(sandbox.accountId);
  if (!isOwner) {
    return { error: 'Only the owner can manage backups', status: 403 as const };
  }
  if (!sandbox.externalId) return { error: 'Sandbox has no external ID', status: 400 as const };
  if (sandbox.provider !== 'justavps') return { error: 'Backups are only supported for cloud sandboxes', status: 400 as const };

  const provider = getProvider('justavps') as JustAVPSProvider;
  return { sandbox, provider, externalId: sandbox.externalId };
}

export function createBackupRouter(
  overrides: Partial<BackupRouterDeps> = {},
): Hono<{ Variables: AuthVariables }> {
  const deps = { ...defaultDeps, ...overrides };
  const { db, getProvider, resolveAccountId } = deps;

  const router = new Hono<{ Variables: AuthVariables }>();

  if (deps.useAuth) {
    router.use('/*', authMiddleware);
  }

  // ─── GET /:sandboxId/backups — List backups ─────────────────────────────

  router.get('/:sandboxId/backups', async (c) => {
    const userId = c.get('userId');
    const sandboxId = c.req.param('sandboxId');

    try {
      const result = await requireAccessibleJustavpsSandbox(db, userId, sandboxId, getProvider, resolveAccountId);
      if ('error' in result) return c.json({ success: false, error: result.error }, result.status);

      const { provider, externalId } = result;
      const data = await provider.listBackups(externalId);

      return c.json({
        success: true,
        data: {
          backups: data.backups,
          backups_enabled: data.backups_enabled,
        },
      });
    } catch (err) {
      console.error('[SANDBOX-BACKUPS] list error:', err);
      return c.json({ success: false, error: 'Failed to list backups' }, 500);
    }
  });

  // ─── POST /:sandboxId/backups — Create manual backup ────────────────────

  router.post('/:sandboxId/backups', async (c) => {
    const userId = c.get('userId');
    const sandboxId = c.req.param('sandboxId');

    try {
      const result = await requireAccessibleJustavpsSandbox(db, userId, sandboxId, getProvider, resolveAccountId);
      if ('error' in result) return c.json({ success: false, error: result.error }, result.status);

      const { provider, externalId } = result;
      const body = await c.req.json().catch(() => ({}));
      const description = body?.description as string | undefined;

      const data = await provider.createBackup(externalId, description);

      return c.json({ success: true, data }, 202);
    } catch (err) {
      console.error('[SANDBOX-BACKUPS] create error:', err);
      return c.json({ success: false, error: 'Failed to create backup' }, 500);
    }
  });

  // ─── POST /:sandboxId/backups/:backupId/restore — Restore from backup ───

  router.post('/:sandboxId/backups/:backupId/restore', async (c) => {
    const userId = c.get('userId');
    const sandboxId = c.req.param('sandboxId');
    const backupId = c.req.param('backupId');

    try {
      const result = await requireAccessibleJustavpsSandbox(db, userId, sandboxId, getProvider, resolveAccountId);
      if ('error' in result) return c.json({ success: false, error: result.error }, result.status);

      const { provider, externalId } = result;
      await provider.restoreBackup(externalId, backupId);

      return c.json({ success: true, data: { action: 'restore_backup', status: 'initiated' } });
    } catch (err) {
      console.error('[SANDBOX-BACKUPS] restore error:', err);
      return c.json({ success: false, error: 'Failed to restore backup' }, 500);
    }
  });

  // ─── DELETE /:sandboxId/backups/:backupId — Delete a backup ─────────────

  router.delete('/:sandboxId/backups/:backupId', async (c) => {
    const userId = c.get('userId');
    const sandboxId = c.req.param('sandboxId');
    const backupId = c.req.param('backupId');

    try {
      const result = await requireAccessibleJustavpsSandbox(db, userId, sandboxId, getProvider, resolveAccountId);
      if ('error' in result) return c.json({ success: false, error: result.error }, result.status);

      const { provider, externalId } = result;
      await provider.deleteBackup(externalId, backupId);

      return c.json({ success: true, data: { action: 'delete_backup', status: 'completed' } });
    } catch (err) {
      console.error('[SANDBOX-BACKUPS] delete error:', err);
      return c.json({ success: false, error: 'Failed to delete backup' }, 500);
    }
  });

  return router;
}

export const backupRouter = createBackupRouter();
