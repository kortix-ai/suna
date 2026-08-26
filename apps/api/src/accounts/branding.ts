// Organization branding — an Enterprise entitlement (`branding`).
//
// An account can replace the Kortix marks its members see in the web app: the
// wide brandmark (`logo`), the square symbol (`icon`), and the browser-tab
// icon (`favicon`), each with an optional dark-scheme variant (`*_dark`).
// Everything lives in ONE jsonb column, `accounts.branding`, and every URL in
// it is API-owned: uploads come through this module and land in the public
// `branding` Storage bucket under `<account_id>/<kind>-<sha256:12>.<ext>`.
// Clients never write a URL — so the stored value can never point outside our
// storage origin, and nothing needs URL validation downstream.
//
// Gating, in the same shape as the other enterprise surfaces (audit, SSO):
//   - writes (`POST …/assets/:kind`) need `account.write` AND the
//     `branding` entitlement — `requireEntitlement` 402s otherwise;
//   - reads and the two removal routes stay ungated (permission only) so a
//     downgraded account can still see and unwind what it set;
//   - SERVING is entitlement-checked: `effectiveBranding` (used by
//     `GET /accounts` and `GET /accounts/:id`) returns `null` the moment the
//     entitlement lapses, so members fall back to Kortix without any write.

import { createHash } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { type AccountBrandingRecord, accounts } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { accountHasEntitlement } from '../billing/services/entitlements';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../iam';
import { actorOf } from '../iam/actor';
import { auth, errors, json } from '../openapi';
import { config } from '../config';
import { db } from '../shared/db';
import { rewriteStorageOrigin } from '../shared/storage-url';
import { getSupabase } from '../shared/supabase';
import { AccountIdParam, accountsRouter, getMembership } from './core/app';
import { auditIam, requireEntitlement } from './iam/helpers';

export const BRANDING_BUCKET = 'branding';
/** Same ceiling the bucket enforces (`storage.buckets.file_size_limit`). */
export const MAX_BRANDING_ASSET_BYTES = 1024 * 1024;

/** Three marks × two color schemes. The `_dark` kinds are optional variants
 *  that fall back to their light counterpart wherever they are unset. */
export const BRANDING_ASSET_KINDS = [
  'logo',
  'icon',
  'favicon',
  'logo_dark',
  'icon_dark',
  'favicon_dark',
] as const;
export type BrandingAssetKind = (typeof BRANDING_ASSET_KINDS)[number];

const ASSET_URL_KEY: Record<BrandingAssetKind, keyof AccountBrandingRecord> = {
  logo: 'logo_url',
  icon: 'icon_url',
  favicon: 'favicon_url',
  logo_dark: 'logo_dark_url',
  icon_dark: 'icon_dark_url',
  favicon_dark: 'favicon_dark_url',
};

// ─── Wire shape ─────────────────────────────────────────────────────────────

export const AccountBrandingSchema = z
  .object({
    logo_url: z.string().nullable(),
    icon_url: z.string().nullable(),
    favicon_url: z.string().nullable(),
    logo_dark_url: z.string().nullable(),
    icon_dark_url: z.string().nullable(),
    favicon_dark_url: z.string().nullable(),
  })
  .openapi('AccountBranding');

export type AccountBranding = z.infer<typeof AccountBrandingSchema>;

const AccountBrandingStateSchema = z
  .object({
    /** What is STORED, whether or not the account may currently use it. */
    branding: AccountBrandingSchema,
    /** Whether the account's plan carries the `branding` entitlement. */
    entitled: z.boolean(),
  })
  .openapi('AccountBrandingState');

const AssetKindParam = z.object({
  accountId: z.string(),
  kind: z.enum(BRANDING_ASSET_KINDS),
});

/** Normalize the stored jsonb into the full, nullable wire shape. */
export function normalizeBranding(record: AccountBrandingRecord | null | undefined): AccountBranding {
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
  return {
    logo_url: str(record?.logo_url),
    icon_url: str(record?.icon_url),
    favicon_url: str(record?.favicon_url),
    logo_dark_url: str(record?.logo_dark_url),
    icon_dark_url: str(record?.icon_dark_url),
    favicon_dark_url: str(record?.favicon_dark_url),
  };
}

export function isBrandingEmpty(branding: AccountBranding): boolean {
  return Object.values(branding).every((v) => v === null);
}

/**
 * The branding members should SEE: the stored record when the account is
 * entitled, `null` when nothing is set or the entitlement has lapsed. The
 * entitlement read only happens for accounts that actually carry branding, so
 * `GET /accounts` costs nothing extra for the overwhelming majority.
 */
export async function effectiveBranding(
  accountId: string,
  record: AccountBrandingRecord | null | undefined,
  hasEntitlement: (accountId: string) => Promise<boolean> = (id) =>
    accountHasEntitlement(id, 'branding'),
): Promise<AccountBranding | null> {
  const branding = normalizeBranding(record);
  if (isBrandingEmpty(branding)) return null;
  if (!(await hasEntitlement(accountId))) return null;
  return branding;
}

// ─── Asset validation ───────────────────────────────────────────────────────

export interface SniffedImage {
  contentType: string;
  ext: string;
}

/**
 * Identify an image by its BYTES, never by the client's declared type: the
 * bucket's mime allowlist is enforced on what we send, and the stored
 * `Content-Type` is what browsers will trust. SVG is text, so it is detected
 * structurally and additionally refused when it carries script — the assets
 * only ever render through `<img>`/`<link rel=icon>` (where script never runs),
 * but a public URL can be opened directly, and defense in depth is cheap.
 */
export function sniffBrandingImage(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 4) return null;
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { contentType: 'image/png', ext: 'png' };
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { contentType: 'image/jpeg', ext: 'jpg' };
  }
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return { contentType: 'image/webp', ext: 'webp' };
  }
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) {
    return { contentType: 'image/x-icon', ext: 'ico' };
  }
  // SVG: decode the head as UTF-8, skip BOM/whitespace/XML prolog/comments,
  // and require an <svg root. Bounded scan — an SVG that buries its root
  // element deeper than 4 KiB of preamble is not a logo.
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(b.subarray(0, Math.min(b.length, 4096)))
    .replace(/^\uFEFF/, '');
  if (/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s/>]/i.test(head)) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(b);
    if (/<script[\s>]|\bon[a-z]+\s*=|javascript:/i.test(text)) return null;
    return { contentType: 'image/svg+xml', ext: 'svg' };
  }
  return null;
}

/** `<account_id>/<kind>-<sha256:12>.<ext>` — content-addressed so a re-upload
 *  changes the URL and no cache anywhere can serve a stale mark. */
export async function brandingObjectPath(
  accountId: string,
  kind: BrandingAssetKind,
  bytes: Uint8Array,
  ext: string,
): Promise<string> {
  const hex = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  return `${accountId}/${kind}-${hex}.${ext}`;
}

/** Recover the bucket-relative object path from one of our own public URLs. */
export function brandingObjectPathFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const marker = `/storage/v1/object/public/${BRANDING_BUCKET}/`;
  const i = url.indexOf(marker);
  if (i === -1) return null;
  const rest = url.slice(i + marker.length).split('?')[0] ?? '';
  return rest.length > 0 ? decodeURIComponent(rest) : null;
}

// ─── Storage ────────────────────────────────────────────────────────────────

async function removeObjects(paths: Array<string | null>): Promise<void> {
  const real = paths.filter((p): p is string => !!p);
  if (real.length === 0) return;
  // Best-effort: a dangling object costs a few KB; a failed remove must never
  // fail the user's request after the row already changed.
  await getSupabase()
    .storage.from(BRANDING_BUCKET)
    .remove(real)
    .catch(() => {});
}

async function loadBrandingRow(accountId: string) {
  const [row] = await db
    .select({ branding: accounts.branding })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  return row ?? null;
}

async function writeBranding(accountId: string, next: AccountBrandingRecord): Promise<AccountBranding> {
  // Store only the keys that carry a value: `{}` stays the canonical "default
  // Kortix" record, and `effectiveBranding` can short-circuit on it.
  const compact: AccountBrandingRecord = {};
  for (const [key, value] of Object.entries(next) as Array<[keyof AccountBrandingRecord, unknown]>) {
    if (typeof value === 'string' && value.length > 0) compact[key] = value;
  }
  const [row] = await db
    .update(accounts)
    .set({ branding: compact, updatedAt: new Date() })
    .where(eq(accounts.accountId, accountId))
    .returning({ branding: accounts.branding });
  return normalizeBranding(row?.branding);
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export function registerBrandingRoutes(): void {
  // GET — the stored record + whether the plan allows it. Any member: the
  // settings pane reads this, and there is nothing secret in a logo URL.
  accountsRouter.openapi(
    createRoute({
      method: 'get',
      path: '/{accountId}/branding',
      tags: ['accounts'],
      summary: 'Get organization branding',
      ...auth,
      request: { params: AccountIdParam },
      responses: {
        200: json(AccountBrandingStateSchema, 'Stored branding and entitlement state'),
        ...errors(401, 403, 404),
      },
    }),
    async (c: any) => {
      const userId = c.get('userId') as string;
      const accountId = c.req.param('accountId');
      if (!(await getMembership(userId, accountId))) return c.json({ error: 'Forbidden' }, 403);
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_READ);

      const row = await loadBrandingRow(accountId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      return c.json({
        branding: normalizeBranding(row.branding),
        entitled: await accountHasEntitlement(accountId, 'branding'),
      });
    },
  );

  // POST …/assets/:kind — multipart upload of one image. Content-addressed
  // object name; the previous object for that kind is removed after the row
  // points at the new one.
  accountsRouter.openapi(
    createRoute({
      method: 'post',
      path: '/{accountId}/branding/assets/{kind}',
      tags: ['accounts'],
      summary: 'Upload a branding asset (logo, icon, or favicon)',
      ...auth,
      request: {
        params: AssetKindParam,
        body: {
          content: {
            'multipart/form-data': {
              schema: z.object({
                file: z.any().openapi({ type: 'string', format: 'binary' }),
              }),
            },
          },
        },
      },
      responses: {
        200: json(AccountBrandingStateSchema, 'Updated branding'),
        ...errors(400, 401, 402, 403, 404, 413),
      },
    }),
    async (c: any) => {
      const userId = c.get('userId') as string;
      const accountId = c.req.param('accountId') as string;
      const kind = c.req.param('kind') as BrandingAssetKind;
      if (!(await getMembership(userId, accountId))) return c.json({ error: 'Forbidden' }, 403);
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE);
      const denied = await requireEntitlement(c, accountId, 'branding');
      if (denied) return denied;

      const form = await c.req.parseBody().catch(() => null);
      const file = form?.file;
      if (!(file instanceof File)) return c.json({ error: 'file (multipart) is required' }, 400);
      if (file.size > MAX_BRANDING_ASSET_BYTES) {
        return c.json(
          { error: `file is too large (max ${MAX_BRANDING_ASSET_BYTES / 1024} KiB)` },
          413,
        );
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sniffed = sniffBrandingImage(bytes);
      if (!sniffed) {
        return c.json({ error: 'file must be a PNG, JPEG, WebP, SVG, or ICO image' }, 400);
      }

      const row = await loadBrandingRow(accountId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      const before = normalizeBranding(row.branding);

      const path = await brandingObjectPath(accountId, kind, bytes, sniffed.ext);
      const storage = getSupabase().storage.from(BRANDING_BUCKET);
      const { error: uploadError } = await storage.upload(path, bytes, {
        contentType: sniffed.contentType,
        // Content-addressed: the URL changes whenever the bytes do.
        cacheControl: '31536000',
        upsert: true,
      });
      if (uploadError) {
        console.error('[branding] upload failed', { accountId, kind, error: uploadError.message });
        return c.json({ error: 'Failed to store the image' }, 500);
      }
      // Same rewrite as `toPublicStorageUrl`, via the pure helper: on a
      // split internal/public self-host the public origin must be what lands
      // in the row, because that URL goes straight into <img src>.
      const url = rewriteStorageOrigin(
        storage.getPublicUrl(path).data.publicUrl,
        config.SUPABASE_URL,
        config.SUPABASE_PUBLIC_URL,
      );

      const key = ASSET_URL_KEY[kind];
      const after = await writeBranding(accountId, { ...before, [key]: url });
      const previous = brandingObjectPathFromUrl(before[key]);
      if (previous && previous !== path) await removeObjects([previous]);

      await auditIam(c, {
        accountId,
        action: 'account.branding.asset.upload',
        resourceType: 'account',
        resourceId: accountId,
        before: { kind, url: before[key] },
        after: { kind, url, bytes: bytes.byteLength, content_type: sniffed.contentType },
      });
      return c.json({ branding: after, entitled: true });
    },
  );

  // DELETE …/assets/:kind — remove one mark. Permission only, no entitlement:
  // unwinding must always be possible.
  accountsRouter.openapi(
    createRoute({
      method: 'delete',
      path: '/{accountId}/branding/assets/{kind}',
      tags: ['accounts'],
      summary: 'Remove a branding asset',
      ...auth,
      request: { params: AssetKindParam },
      responses: {
        200: json(AccountBrandingStateSchema, 'Updated branding'),
        ...errors(401, 403, 404),
      },
    }),
    async (c: any) => {
      const userId = c.get('userId') as string;
      const accountId = c.req.param('accountId') as string;
      const kind = c.req.param('kind') as BrandingAssetKind;
      if (!(await getMembership(userId, accountId))) return c.json({ error: 'Forbidden' }, 403);
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE);

      const row = await loadBrandingRow(accountId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      const before = normalizeBranding(row.branding);
      const key = ASSET_URL_KEY[kind];
      const after = await writeBranding(accountId, { ...before, [key]: null });
      await removeObjects([brandingObjectPathFromUrl(before[key])]);

      if (before[key]) {
        await auditIam(c, {
          accountId,
          action: 'account.branding.asset.remove',
          resourceType: 'account',
          resourceId: accountId,
          before: { kind, url: before[key] },
          after: { kind, url: null },
        });
      }
      return c.json({ branding: after, entitled: await accountHasEntitlement(accountId, 'branding') });
    },
  );

  // DELETE — reset everything to Kortix defaults. Permission only.
  accountsRouter.openapi(
    createRoute({
      method: 'delete',
      path: '/{accountId}/branding',
      tags: ['accounts'],
      summary: 'Reset organization branding to defaults',
      ...auth,
      request: { params: AccountIdParam },
      responses: {
        200: json(AccountBrandingStateSchema, 'Branding after reset'),
        ...errors(401, 403, 404),
      },
    }),
    async (c: any) => {
      const userId = c.get('userId') as string;
      const accountId = c.req.param('accountId') as string;
      if (!(await getMembership(userId, accountId))) return c.json({ error: 'Forbidden' }, 403);
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE);

      const row = await loadBrandingRow(accountId);
      if (!row) return c.json({ error: 'Not found' }, 404);
      const before = normalizeBranding(row.branding);
      const after = await writeBranding(accountId, {});
      await removeObjects(
        BRANDING_ASSET_KINDS.map((k) => brandingObjectPathFromUrl(before[ASSET_URL_KEY[k]])),
      );

      if (!isBrandingEmpty(before)) {
        await auditIam(c, {
          accountId,
          action: 'account.branding.reset',
          resourceType: 'account',
          resourceId: accountId,
          before: { ...before },
          after: { ...after },
        });
      }
      return c.json({ branding: after, entitled: await accountHasEntitlement(accountId, 'branding') });
    },
  );
}
