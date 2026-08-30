/**
 * `project_crafts` materialization — the DB half of the craft reconciler.
 *
 * Mirrors `./trigger-runtime-catalog.ts` exactly: the pure reconcile lives in
 * `./craft-catalog-core.ts` (injectable store, unit-testable with no DB), and
 * this module is the one drizzle-backed implementation of that store.
 */

import { crafts, projectCrafts } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  type ProjectCraftCatalogStore,
  reconcileProjectCraftsWithStore,
} from './craft-catalog-core';
import type { CraftEntrySpec } from './crafts';

const databaseStore: ProjectCraftCatalogStore = {
  async list(projectId) {
    return db
      .select({
        slug: projectCrafts.slug,
        repoOwner: projectCrafts.repoOwner,
        repoName: projectCrafts.repoName,
        gitRef: projectCrafts.gitRef,
        resolvedSha: projectCrafts.resolvedSha,
        title: projectCrafts.title,
        owns: projectCrafts.owns,
      })
      .from(projectCrafts)
      .where(eq(projectCrafts.projectId, projectId));
  },

  async upsert(projectId, spec) {
    const now = new Date();
    // Link to the index row for this repo+ref when one exists. A correlated
    // sub-select keeps it to one statement, and a NULL result is correct rather
    // than an error: a craft installed from a repo the index does not carry is
    // still installed. `coalesce(git_ref,'')` mirrors `idx_crafts_repo_ref`, so
    // "the default branch" matches the same single row the unique index allows.
    const craftIdFromIndex = sql<string | null>`(
      select ${crafts.craftId} from ${crafts}
       where ${crafts.repoOwner} = ${spec.repoOwner}
         and ${crafts.repoName} = ${spec.repoName}
         and coalesce(${crafts.gitRef}, '') = ${spec.gitRef ?? ''}
       limit 1
    )`;

    await db
      .insert(projectCrafts)
      .values({
        projectId,
        slug: spec.slug,
        craftId: craftIdFromIndex,
        repoOwner: spec.repoOwner,
        repoName: spec.repoName,
        gitRef: spec.gitRef,
        resolvedSha: spec.resolvedSha,
        title: spec.title,
        owns: spec.owns as Record<string, string[]>,
        // Bind the ISO string with an explicit cast, never a JS Date: inside a
        // raw `sql` fragment postgres-js serializes a Date with its locale
        // `toString()`, which Postgres cannot parse as a timestamp (the
        // 2026-08-27 runtime-projection incident).
        installedAt: spec.installedAt
          ? sql`${spec.installedAt}::timestamptz`
          : sql`coalesce(${projectCrafts.installedAt}, ${now})`,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [projectCrafts.projectId, projectCrafts.slug],
        set: {
          craftId: craftIdFromIndex,
          repoOwner: spec.repoOwner,
          repoName: spec.repoName,
          gitRef: spec.gitRef,
          resolvedSha: spec.resolvedSha,
          title: spec.title,
          owns: spec.owns as Record<string, string[]>,
          // `installed_at` is when the craft FIRST landed here. A later
          // reconcile must not move it, so an entry that records no instant
          // keeps whatever the row already had.
          ...(spec.installedAt ? { installedAt: sql`${spec.installedAt}::timestamptz` } : {}),
          lastError: null,
          updatedAt: now,
        },
      });
  },

  async remove(projectId, slug) {
    await db
      .delete(projectCrafts)
      .where(and(eq(projectCrafts.projectId, projectId), eq(projectCrafts.slug, slug)));
  },
};

/**
 * Converge `project_crafts` on the manifest, deleting rows the manifest no
 * longer declares. Use on a write path, where the manifest just committed.
 */
export async function reconcileProjectCrafts(
  projectId: string,
  specs: readonly CraftEntrySpec[],
  store: ProjectCraftCatalogStore = databaseStore,
): Promise<{ upserted: number; removed: number }> {
  return reconcileProjectCraftsWithStore(projectId, specs, store);
}

/**
 * Non-destructive form for GET paths: every craft visible in one manifest read
 * gets its row, and nothing absent from that read is deleted. A concurrent API
 * task can briefly observe an older git checkout, and a read must never be the
 * thing that uninstalls a craft.
 */
export async function ensureProjectCrafts(
  projectId: string,
  specs: readonly CraftEntrySpec[],
  store: ProjectCraftCatalogStore = databaseStore,
): Promise<{ upserted: number; removed: number }> {
  return reconcileProjectCraftsWithStore(projectId, specs, store, { pruneStale: false });
}
