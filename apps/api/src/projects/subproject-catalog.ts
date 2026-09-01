/**
 * `project_subprojects` materialization — the DB half of the subproject reconciler.
 *
 * Mirrors `./trigger-runtime-catalog.ts` exactly: the pure reconcile lives in
 * `./subproject-catalog-core.ts` (injectable store, unit-testable with no DB), and
 * this module is the one drizzle-backed implementation of that store.
 */

import { subprojects, projectSubprojects } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  type ProjectSubprojectCatalogStore,
  reconcileProjectSubprojectsWithStore,
} from './subproject-catalog-core';
import type { SubprojectEntrySpec } from './subprojects';

const databaseStore: ProjectSubprojectCatalogStore = {
  async list(projectId) {
    return db
      .select({
        slug: projectSubprojects.slug,
        repoOwner: projectSubprojects.repoOwner,
        repoName: projectSubprojects.repoName,
        gitRef: projectSubprojects.gitRef,
        resolvedSha: projectSubprojects.resolvedSha,
        title: projectSubprojects.title,
        owns: projectSubprojects.owns,
      })
      .from(projectSubprojects)
      .where(eq(projectSubprojects.projectId, projectId));
  },

  async upsert(projectId, spec) {
    const now = new Date();
    // Link to the index row for this repo+ref when one exists. A correlated
    // sub-select keeps it to one statement, and a NULL result is correct rather
    // than an error: a subproject installed from a repo the index does not carry is
    // still installed. `coalesce(git_ref,'')` mirrors `idx_subprojects_repo_ref`, so
    // "the default branch" matches the same single row the unique index allows.
    const subprojectIdFromIndex = sql<string | null>`(
      select ${subprojects.subprojectId} from ${subprojects}
       where ${subprojects.repoOwner} = ${spec.repoOwner}
         and ${subprojects.repoName} = ${spec.repoName}
         and coalesce(${subprojects.gitRef}, '') = ${spec.gitRef ?? ''}
       limit 1
    )`;

    await db
      .insert(projectSubprojects)
      .values({
        projectId,
        slug: spec.slug,
        subprojectId: subprojectIdFromIndex,
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
          : sql`coalesce(${projectSubprojects.installedAt}, ${now})`,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [projectSubprojects.projectId, projectSubprojects.slug],
        set: {
          subprojectId: subprojectIdFromIndex,
          repoOwner: spec.repoOwner,
          repoName: spec.repoName,
          gitRef: spec.gitRef,
          resolvedSha: spec.resolvedSha,
          title: spec.title,
          owns: spec.owns as Record<string, string[]>,
          // `installed_at` is when the subproject FIRST landed here. A later
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
      .delete(projectSubprojects)
      .where(and(eq(projectSubprojects.projectId, projectId), eq(projectSubprojects.slug, slug)));
  },
};

/**
 * Converge `project_subprojects` on the manifest, deleting rows the manifest no
 * longer declares. Use on a write path, where the manifest just committed.
 */
export async function reconcileProjectSubprojects(
  projectId: string,
  specs: readonly SubprojectEntrySpec[],
  store: ProjectSubprojectCatalogStore = databaseStore,
): Promise<{ upserted: number; removed: number }> {
  return reconcileProjectSubprojectsWithStore(projectId, specs, store);
}

/**
 * Non-destructive form for GET paths: every subproject visible in one manifest read
 * gets its row, and nothing absent from that read is deleted. A concurrent API
 * task can briefly observe an older git checkout, and a read must never be the
 * thing that uninstalls a subproject.
 */
export async function ensureProjectSubprojects(
  projectId: string,
  specs: readonly SubprojectEntrySpec[],
  store: ProjectSubprojectCatalogStore = databaseStore,
): Promise<{ upserted: number; removed: number }> {
  return reconcileProjectSubprojectsWithStore(projectId, specs, store, { pruneStale: false });
}
