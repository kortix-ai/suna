/**
 * The row an App of kind `convex` is read as: its machine row
 * (`app_convex_instances`) joined with the App fields the machine code reads.
 * A light module (db + drizzle only): the host proxy imports it on the hot path.
 */
import { appConvexInstances, apps } from '@kortix/db';
import { and, eq, getTableColumns, isNull, ne } from 'drizzle-orm';
import { db } from '../../../shared/db';

/** An App of kind `convex`: its machine row joined with the App fields the machine code reads. */
export type ConvexRow = typeof appConvexInstances.$inferSelect & {
  projectId: string;
  accountId: string;
  slug: string;
  cpu: number;
  memoryGb: number;
  diskGb: number;
  monthlyBudgetUsd: string;
  deletedAt: Date | null;
};

export const CONVEX_ROW = {
  ...getTableColumns(appConvexInstances),
  projectId: apps.projectId,
  accountId: apps.accountId,
  slug: apps.slug,
  cpu: apps.cpuCores,
  memoryGb: apps.memoryGb,
  diskGb: apps.diskGb,
  monthlyBudgetUsd: apps.monthlyBudgetUsd,
  deletedAt: apps.deletedAt,
};

/** `select … from app_convex_instances join apps`: every ConvexRow query starts here. */
export function selectConvexRows() {
  return db.select(CONVEX_ROW).from(appConvexInstances).innerJoin(apps, eq(apps.appId, appConvexInstances.appId));
}

/** SQL: the App is not deleted (its machine row is not in retention). */
export const liveInstance = () => ne(appConvexInstances.status, 'deleted');
/** SQL, for a joined query: the App and its machine are live. */
export const liveConvexApp = () => and(isNull(apps.deletedAt), liveInstance());
