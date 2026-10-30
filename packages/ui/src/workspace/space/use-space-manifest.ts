'use client';

import { useQueryClient } from '@tanstack/react-query';

import { getProjectDetail, readProjectFile, writeProjectFile } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';

/**
 * Edit the project's `kortix.yaml` on its default branch: read the file,
 * apply `change` to its text, write it back against the revision it read (a
 * concurrent edit answers 409 instead of being overwritten), then refetch the
 * config. Each call is one commit, the same write My Kortix makes through a
 * change request.
 */
export function useManifestWrite(projectId: string) {
  const queryClient = useQueryClient();
  return async (change: (yamlText: string) => string) => {
    const detail = await queryClient.fetchQuery({
      queryKey: qk.project.detail(projectId),
      queryFn: () => getProjectDetail(projectId),
    });
    const path = detail.project.manifest_path || 'kortix.yaml';
    const ref = detail.project.default_branch || 'main';
    const file = await readProjectFile(projectId, path, ref);
    if (!file.revision) throw new Error(`Could not read ${path}.`);
    await writeProjectFile(projectId, { path, ref, content: change(file.content), expected_revision: file.revision });
    await queryClient.invalidateQueries({ queryKey: qk.project.detail(projectId) });
  };
}
