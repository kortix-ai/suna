import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  type ProjectImageOrphanCleanupDeps,
  cleanupOrphanedFastProjectImageBuild,
} from './project-image-orphan-cleanup';

const PROJECT_ID = '9ee8bc9c-5108-437f-a01f-6c5e26f2062c';
const SNAPSHOT_NAME = 'kpp2-123456789abc-123456789abc-1234567890abcdef-fedcba0987654321';

function deps(project: { status: 'active' | 'archived' } | null): ProjectImageOrphanCleanupDeps & {
  reads: string[];
  deletes: Array<{ snapshotName: string; provider: string }>;
  infos: string[];
  warnings: string[];
} {
  const reads: string[] = [];
  const deletes: Array<{ snapshotName: string; provider: string }> = [];
  const infos: string[] = [];
  const warnings: string[] = [];
  return {
    reads,
    deletes,
    infos,
    warnings,
    readProject: async (projectId) => {
      reads.push(projectId);
      return project;
    },
    deleteProjectImage: async (snapshotName, provider) => {
      deletes.push({ snapshotName, provider });
    },
    info: (message) => infos.push(message),
    warn: (message) => warnings.push(message),
  };
}

describe('cleanupOrphanedFastProjectImageBuild', () => {
  test('keeps the image when the active project still exists', async () => {
    const io = deps({ status: 'active' });

    await expect(
      cleanupOrphanedFastProjectImageBuild(
        { projectId: PROJECT_ID, snapshotName: SNAPSHOT_NAME, provider: 'platinum' },
        io,
      ),
    ).resolves.toEqual({ outcome: 'kept', reason: 'project_active' });

    expect(io.reads).toEqual([PROJECT_ID]);
    expect(io.deletes).toEqual([]);
  });

  test.each([
    { label: 'archived', project: { status: 'archived' as const }, reason: 'project_archived' },
    { label: 'absent', project: null, reason: 'project_absent' },
  ])('deletes only the completed build when the project is $label', async ({ project, reason }) => {
    const io = deps(project);

    await expect(
      cleanupOrphanedFastProjectImageBuild(
        { projectId: PROJECT_ID, snapshotName: SNAPSHOT_NAME, provider: 'platinum' },
        io,
      ),
    ).resolves.toEqual({ outcome: 'deleted', reason });

    expect(io.deletes).toEqual([{ snapshotName: SNAPSHOT_NAME, provider: 'platinum' }]);
    expect(io.infos).toEqual([expect.stringContaining(`deleted ${SNAPSHOT_NAME}`)]);
  });

  test('keeps the image when an active row exists for a reused project id', async () => {
    const io = deps({ status: 'active' });

    const result = await cleanupOrphanedFastProjectImageBuild(
      { projectId: PROJECT_ID, snapshotName: SNAPSHOT_NAME, provider: 'daytona' },
      io,
    );

    expect(result).toEqual({ outcome: 'kept', reason: 'project_active' });
    expect(io.deletes).toEqual([]);
  });

  test('keeps the image when the project-state read fails', async () => {
    const io = deps(null);
    io.readProject = async () => {
      throw new Error('database unavailable');
    };

    await expect(
      cleanupOrphanedFastProjectImageBuild(
        { projectId: PROJECT_ID, snapshotName: SNAPSHOT_NAME, provider: 'platinum' },
        io,
      ),
    ).resolves.toEqual({ outcome: 'kept', reason: 'project_read_failed' });

    expect(io.deletes).toEqual([]);
    expect(io.warnings).toEqual([expect.stringContaining(`kept ${SNAPSHOT_NAME}`)]);
  });

  test('contains image-delete failures and reports that the orphan remains', async () => {
    const io = deps(null);
    io.deleteProjectImage = async () => {
      throw new Error('provider unavailable');
    };

    await expect(
      cleanupOrphanedFastProjectImageBuild(
        { projectId: PROJECT_ID, snapshotName: SNAPSHOT_NAME, provider: 'platinum' },
        io,
      ),
    ).resolves.toEqual({ outcome: 'kept', reason: 'image_delete_failed' });

    expect(io.warnings).toEqual([expect.stringContaining(`could not delete ${SNAPSHOT_NAME}`)]);
  });

  test('runs only after a newly built optional FAST image and uses the result name', () => {
    const source = readFileSync(new URL('./builder.ts', import.meta.url), 'utf8');
    const background = source.slice(
      source.indexOf('function kickBackgroundWarmBuild'),
      source.indexOf('export async function kickProjectWarmPrebake'),
    );

    expect(background).toContain('const result = await ensurePerProjectWarmImage(');
    expect(background).toContain('if (fastEnabled && result.built)');
    expect(background).toContain('snapshotName: result.snapshotName');
    expect(background).toContain('provider: opts.provider');
    expect(background).toContain('await cleanupOrphanedFastProjectImageBuild(');
  });
});
