/**
 * DB-suite helpers for Apps of kind `convex`: one call writes the App row and
 * its machine row (`app_convex_instances`), the way `insertConvexApp` does,
 * with any field a test needs to preset. Synthetic values only.
 */
import { randomBytes } from 'node:crypto';
import { appConvexInstances, apps } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db';
import { type ConvexRow, selectConvexRows } from '../../apps/kinds/convex/rows';

export interface ConvexRowSeed {
  appId?: string;
  projectId: string;
  accountId: string;
  slug: string;
  status?: string;
  provider?: string;
  externalId?: string | null;
  url?: string | null;
  siteUrl?: string | null;
  adminKeyEnc?: string | null;
  authKeyEnc?: string | null;
  authIssuer?: string | null;
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
  monthlyBudgetUsd?: string;
  createdAt?: Date;
  deletedAt?: Date | null;
  metadata?: Record<string, unknown>;
}

/** Inserts a `convex` App and its machine row; returns the joined row. */
export async function insertConvexRow(seed: ConvexRowSeed): Promise<ConvexRow> {
  const appId = seed.appId ?? crypto.randomUUID();
  await db.insert(apps).values({
    appId,
    accountId: seed.accountId,
    projectId: seed.projectId,
    slug: seed.slug,
    name: seed.slug,
    kind: 'convex',
    routeKey: randomBytes(8).toString('hex'),
    accessMode: 'project',
    alwaysOn: true,
    cpuCores: seed.cpu ?? 1,
    memoryGb: seed.memoryGb ?? 1,
    diskGb: seed.diskGb ?? 10,
    monthlyBudgetUsd: seed.monthlyBudgetUsd ?? '100.00',
    deletedAt: seed.deletedAt ?? null,
    ...(seed.createdAt ? { createdAt: seed.createdAt } : {}),
  });
  await db.insert(appConvexInstances).values({
    appId,
    status: seed.status ?? 'running',
    provider: seed.provider ?? 'platinum',
    externalId: seed.externalId ?? null,
    url: seed.url ?? null,
    siteUrl: seed.siteUrl ?? null,
    adminKeyEnc: seed.adminKeyEnc ?? null,
    authKeyEnc: seed.authKeyEnc ?? null,
    authIssuer: seed.authIssuer ?? null,
    metadata: seed.metadata ?? {},
    ...(seed.createdAt ? { createdAt: seed.createdAt } : {}),
  });
  return (await readConvexRow(appId))!;
}

/** The joined row of a `convex` App, in any state; undefined once its machine row is purged. */
export async function readConvexRow(appId: string): Promise<ConvexRow | undefined> {
  const [row] = await selectConvexRows().where(eq(appConvexInstances.appId, appId));
  return row;
}
