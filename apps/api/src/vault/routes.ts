// Vault REST surface — account-owned secrets / credentials. Mounted under
// accountsRouter at /v1/accounts/:accountId/vault/*. Auth inherited from the
// parent (supabaseAuth populates userId).
//
// Authorization:
//   - any member may create/manage their OWN private items (owner_user_id=self)
//   - shared items (global / select-members) require secret.write (admin)
//   - sharing (grants) requires secret.share (admin)
//   - listing requires account.read (members have it via the Member baseline)
import { Context, Hono } from 'hono';
import type { AppEnv } from '../types';
import { ACCOUNT_ACTIONS, assertAuthorized, authorize } from '../iam';
import { isValidVaultName } from './crypto';
import {
  deleteVaultItem,
  getVaultItem,
  listVaultItems,
  setItemGrants,
  updateVaultItemValue,
  upsertVaultItem,
  visibilityOf,
  type VaultKind,
  type VaultVisibility,
} from './repository';

export const vaultRouter = new Hono<AppEnv>();

const KINDS: VaultKind[] = ['env', 'api_key', 'oauth_token', 'oauth_client', 'connection_secret'];

async function readBody(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) ?? {};
  } catch {
    return {};
  }
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

// GET /:accountId/vault?project_id=
vaultRouter.get('/:accountId/vault', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);
  const isAdmin = (await authorize(userId, accountId, ACCOUNT_ACTIONS.SECRET_WRITE)).allowed;

  const projectIdQ = c.req.query('project_id');
  const items = await listVaultItems({
    accountId,
    projectId: projectIdQ === undefined ? undefined : projectIdQ === 'null' ? null : projectIdQ,
  });

  const visible = items.filter((it) => {
    if (it.ownerUserId === userId) return true; // my private
    if (it.ownerUserId !== null) return false; // someone else's private
    if (isAdmin) return true; // admin sees all shared
    return it.grantUserIds.length === 0 || it.grantUserIds.includes(userId); // usable shared
  });

  return c.json({
    items: visible.map((it) => ({
      item_id: it.itemId,
      kind: it.kind,
      name: it.name,
      project_id: it.projectId,
      owner_user_id: it.ownerUserId,
      provider_id: it.providerId,
      visibility: visibilityOf(it, it.grantUserIds.length),
      grant_user_ids: it.ownerUserId === null && (isAdmin || it.grantUserIds.includes(userId)) ? it.grantUserIds : [],
      can_edit: it.ownerUserId === userId || isAdmin,
      created_at: it.createdAt.toISOString(),
      updated_at: it.updatedAt.toISOString(),
    })),
  });
});

// POST /:accountId/vault   { name, value, kind?, visibility, project_id?, grant_user_ids?, provider_id? }
vaultRouter.post('/:accountId/vault', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ); // membership

  const body = await readBody(c);
  const name = str(body.name)?.toUpperCase() ?? null;
  const value = typeof body.value === 'string' ? body.value : null;
  if (!name || !isValidVaultName(name)) return c.json({ error: 'name must be UPPER_SNAKE_CASE' }, 400);
  if (value === null) return c.json({ error: 'value is required' }, 400);

  const visibility = (str(body.visibility) ?? 'global') as VaultVisibility;
  if (!['global', 'private', 'select'].includes(visibility)) return c.json({ error: 'invalid visibility' }, 400);
  const kind = (str(body.kind) ?? 'env') as VaultKind;
  if (!KINDS.includes(kind)) return c.json({ error: 'invalid kind' }, 400);
  const projectId = str(body.project_id);
  const providerId = str(body.provider_id);
  const grantUserIds = Array.isArray(body.grant_user_ids) ? body.grant_user_ids.filter((x): x is string => typeof x === 'string') : [];

  const isPrivate = visibility === 'private';
  if (!isPrivate) {
    // creating/altering a SHARED item is an admin action
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.SECRET_WRITE);
  }

  const item = await upsertVaultItem({
    accountId,
    name,
    value,
    kind,
    projectId,
    ownerUserId: isPrivate ? userId : null,
    providerId,
    createdBy: userId,
  });

  if (!isPrivate) {
    if (visibility === 'select') {
      await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.SECRET_SHARE);
      await setItemGrants(item.itemId, grantUserIds);
    } else {
      await setItemGrants(item.itemId, []); // global = no grants
    }
  }

  return c.json({ item_id: item.itemId, name: item.name, visibility }, 201);
});

// PATCH /:accountId/vault/:itemId   { value?, grant_user_ids? }
vaultRouter.patch('/:accountId/vault/:itemId', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const itemId = c.req.param('itemId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);

  const item = await getVaultItem(accountId, itemId);
  if (!item) return c.json({ error: 'Not found' }, 404);

  const isAdmin = (await authorize(userId, accountId, ACCOUNT_ACTIONS.SECRET_WRITE)).allowed;
  const canEdit = item.ownerUserId === userId || isAdmin;
  if (!canEdit) return c.json({ error: 'Forbidden' }, 403);

  const body = await readBody(c);
  if (typeof body.value === 'string') {
    await updateVaultItemValue(accountId, itemId, body.value);
  }
  if (Array.isArray(body.grant_user_ids)) {
    if (item.ownerUserId !== null) return c.json({ error: 'private items cannot be shared' }, 400);
    await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.SECRET_SHARE);
    await setItemGrants(itemId, body.grant_user_ids.filter((x): x is string => typeof x === 'string'));
  }
  return c.json({ ok: true });
});

// DELETE /:accountId/vault/:itemId
vaultRouter.delete('/:accountId/vault/:itemId', async (c) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const itemId = c.req.param('itemId');
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);

  const item = await getVaultItem(accountId, itemId);
  if (!item) return c.json({ error: 'Not found' }, 404);
  const isAdmin = (await authorize(userId, accountId, ACCOUNT_ACTIONS.SECRET_WRITE)).allowed;
  if (!(item.ownerUserId === userId || isAdmin)) return c.json({ error: 'Forbidden' }, 403);

  await deleteVaultItem(accountId, itemId);
  return c.json({ ok: true });
});
