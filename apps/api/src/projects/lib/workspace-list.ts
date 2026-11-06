/**
 * The rows behind `GET /v1/workspaces` (design.md §3.2 C5): the caller's
 * workspace candidates come from the workspaces store
 * (`listUserWorkspaceCandidates`); this file turns one record into the
 * project row the serializer takes, and orders the list.
 */
import type { WorkspaceRecord } from '../../workspaces/surface';
import type { ProjectRow } from './serializers';

/**
 * The project row of a workspace record, for `serializeProject`. A
 * `setup_required` workspace (no config repo yet) has `project_id =
 * workspace_id` and empty config-repo fields (design.md §3.2 C5). A `deleting`
 * workspace serves its archived project row. Pure: exported for tests.
 */
export function projectRowOfRecord(record: WorkspaceRecord): ProjectRow {
  return {
    projectId: record.projectId ?? record.workspaceId,
    accountId: record.accountId,
    name: record.name,
    repoUrl: record.repoUrl ?? '',
    defaultBranch: record.defaultBranch ?? 'main',
    manifestPath: record.manifestPath ?? 'kortix.yaml',
    status: record.projectStatus ?? 'active',
    secretDefaultStrategy: (record.secretDefaultStrategy ?? 'runtime') as ProjectRow['secretDefaultStrategy'],
    metadata: record.metadata ?? {},
    idempotencyKey: record.idempotencyKey,
    sandboxProviderGeneration: record.sandboxProviderGeneration ?? 0,
    lastOpenedAt: record.lastOpenedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    splitPending: record.splitPending,
  } as ProjectRow;
}

/**
 * The list order of every workspace list: most recently opened first (never
 * opened last), then by name, then by id. Pure: exported for tests.
 */
export function compareWorkspaceRows(
  a: { lastOpenedAt: Date | null; name: string; projectId: string },
  b: { lastOpenedAt: Date | null; name: string; projectId: string },
): number {
  const at = a.lastOpenedAt?.getTime() ?? null;
  const bt = b.lastOpenedAt?.getTime() ?? null;
  if (at !== bt) {
    if (at === null) return 1;
    if (bt === null) return -1;
    return bt - at;
  }
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0;
}
