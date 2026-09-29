import { connectors, projectTriggerRuntime, projects } from '@kortix/db';
import { and, eq, gt, or, sql } from 'drizzle-orm';
import { qualifiedColumn } from '../../shared/sql-qualified-column';
import { db } from '../../shared/db';
import { invalidateProjectMirror } from '../git';
import { countUncatalogedTriggerProjects } from '../trigger-execution-store';
import type { ProjectRow } from './serializers';
import { schedulerHealth, connectorProjectConcurrency, connectorProjectTimeoutMs, manifestCatalogBatchSize, manifestDiscoveryBatchSize, mapWithConcurrency, withTimeout } from './trigger-scheduler-state';

let manifestCatalogCursor: string | null = null;

/** Select one keyset-paginated batch of known trigger or connector projects. */
async function selectManifestCatalogProjects(): Promise<ProjectRow[]> {
  const limit = manifestCatalogBatchSize();
  const catalogPredicate = or(
    sql`exists (
      select 1
      from ${projectTriggerRuntime}
      where ${projectTriggerRuntime.projectId} = ${qualifiedColumn(projects.projectId)}
    )`,
    sql`exists (
      select 1
      from ${connectors}
      where ${connectors.projectId} = ${qualifiedColumn(projects.projectId)}
    )`,
  );
  const rows = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.status, 'active'),
        manifestCatalogCursor ? gt(projects.projectId, manifestCatalogCursor) : undefined,
        catalogPredicate,
      ),
    )
    .orderBy(projects.projectId)
    .limit(limit);

  manifestCatalogCursor = rows.length < limit ? null : (rows.at(-1)?.projectId ?? null);
  return rows;
}

let manifestDiscoveryCursor: string | null = null;

/**
 * Select one keyset-paginated batch for raw git pushes.
 *
 * CRUD and `kortix ship` reconcile immediately. This rotating batch is the
 * backstop for pushes that bypass both paths.
 */
async function selectManifestDiscoveryProjects(): Promise<ProjectRow[]> {
  const limit = manifestDiscoveryBatchSize();
  const rows = await db
    .select()
    .from(projects)
    .where(
      manifestDiscoveryCursor
        ? and(eq(projects.status, 'active'), gt(projects.projectId, manifestDiscoveryCursor))
        : eq(projects.status, 'active'),
    )
    .orderBy(projects.projectId)
    .limit(limit);

  manifestDiscoveryCursor = rows.length < limit ? null : (rows.at(-1)?.projectId ?? null);
  return rows;
}

export let connectorSweepRunning = false;

export async function runProjectConnectorSweep(): Promise<{
  scanned: number;
  synced: number;
  errors: number;
}> {
  if (connectorSweepRunning) return { scanned: 0, synced: 0, errors: 0 };
  connectorSweepRunning = true;
  const startedMs = Date.now();
  const out = { scanned: 0, synced: 0, errors: 0 };
  let status: 'completed' | 'failed' = 'completed';
  let catalogCycleCompleted = false;
  let discoveryCycleCompleted = false;
  try {
    const { syncProjectConnectors } = await import('../../connectors/sync');
    const [catalogProjects, discoveryProjects] = await Promise.all([
      selectManifestCatalogProjects(),
      selectManifestDiscoveryProjects(),
    ]);
    catalogCycleCompleted = manifestCatalogCursor === null;
    discoveryCycleCompleted = manifestDiscoveryCursor === null;
    const uniqueProjects = new Map<string, ProjectRow>();
    for (const project of [...catalogProjects, ...discoveryProjects]) {
      uniqueProjects.set(project.projectId, project);
    }
    const projectsForSweep = [...uniqueProjects.values()];

    const results = await mapWithConcurrency(
      projectsForSweep,
      connectorProjectConcurrency(),
      async (project) => {
        invalidateProjectMirror(project.projectId);
        try {
          const result = await withTimeout(
            syncProjectConnectors(project.projectId, project.accountId),
            connectorProjectTimeoutMs(),
            `sync connectors ${project.projectId}`,
          );
          return { synced: result.synced, errors: result.errors.length };
        } catch (error) {
          console.warn('[project-connectors] project reconcile failed', {
            projectId: project.projectId,
            error: error instanceof Error ? error.message : String(error),
          });
          return { synced: 0, errors: 1 };
        }
      },
    );
    out.scanned = projectsForSweep.length;
    for (const result of results) {
      out.synced += result.synced;
      out.errors += result.errors;
    }
    schedulerHealth.catalogPendingProjects = await countUncatalogedTriggerProjects();
    schedulerHealth.lastCatalogSweepError = null;
    return out;
  } catch (error) {
    status = 'failed';
    out.errors += 1;
    schedulerHealth.lastCatalogSweepError = error instanceof Error ? error.message : String(error);
    console.error('[project-connectors] sweep failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return out;
  } finally {
    const completedAt = new Date().toISOString();
    schedulerHealth.lastCatalogSweepCompletedAt = completedAt;
    schedulerHealth.lastCatalogSweepResult = out;
    schedulerHealth.catalogCursor = manifestCatalogCursor;
    schedulerHealth.discoveryCursor = manifestDiscoveryCursor;
    if (status === 'completed' && catalogCycleCompleted) {
      schedulerHealth.catalogCycleCompletedAt = completedAt;
    }
    if (status === 'completed' && discoveryCycleCompleted) {
      schedulerHealth.discoveryCycleCompletedAt = completedAt;
    }
    connectorSweepRunning = false;
    console.log('[project-connectors] sweep completed', {
      status,
      durationMs: Date.now() - startedMs,
      ...out,
      catalogCursor: manifestCatalogCursor,
      discoveryCursor: manifestDiscoveryCursor,
    });
  }
}
