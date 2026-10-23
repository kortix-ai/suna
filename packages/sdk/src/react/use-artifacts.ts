'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createArtifact,
  deleteArtifact,
  getArtifact,
  listArtifactTypes,
  listArtifactVersions,
  listArtifacts,
  publishArtifactVersion,
  restoreArtifactVersion,
  setArtifactPinned,
  updateArtifact,
  type ArtifactListScope,
  type ArtifactType,
  type PublishArtifactInput,
  type UpdateArtifactInput,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/** The project's artifacts the caller may view (flag `artifacts`), newest change first. */
export function useArtifacts(
  projectId: string | null | undefined,
  filter: { scope?: ArtifactListScope; type?: ArtifactType; q?: string } = {},
) {
  return useQuery({
    queryKey: qk.project.artifactList(projectId ?? '', JSON.stringify(filter)),
    queryFn: () => listArtifacts(projectId as string, filter),
    enabled: !!projectId,
    ...contract('inventory'),
  });
}

/** One artifact at a version (default current), with its files and a signed `view_url`. */
export function useArtifact(projectId: string | null | undefined, artifactId: string | null | undefined, version?: number) {
  return useQuery({
    queryKey: qk.project.artifact(projectId ?? '', artifactId ?? '', version ?? 'current'),
    queryFn: () => getArtifact(projectId as string, artifactId as string, version ? { version } : {}),
    enabled: !!projectId && !!artifactId,
    ...contract('inventory'),
  });
}

export function useArtifactVersions(projectId: string | null | undefined, artifactId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: qk.project.artifactVersions(projectId ?? '', artifactId ?? ''),
    queryFn: () => listArtifactVersions(projectId as string, artifactId as string),
    enabled: enabled && !!projectId && !!artifactId,
    ...contract('inventory'),
  });
}

/** The types, their format and a starter page. They change only with a deploy. */
export function useArtifactTypes(projectId: string | null | undefined) {
  return useQuery({
    queryKey: qk.project.artifactTypes(projectId ?? ''),
    queryFn: () => listArtifactTypes(projectId as string),
    enabled: !!projectId,
    ...contract('config'),
  });
}

/** Every write; each one refreshes the gallery and the open artifact. */
export function useArtifactMutations(projectId: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: qk.project.artifacts(projectId) });
  const opts = { onSuccess: refresh };
  return {
    create: useMutation({ mutationFn: (input: PublishArtifactInput) => createArtifact(projectId, input), ...opts }),
    publish: useMutation({
      mutationFn: ({ artifactId, ...input }: Omit<PublishArtifactInput, 'visibility'> & { artifactId: string }) =>
        publishArtifactVersion(projectId, artifactId, input),
      ...opts,
    }),
    update: useMutation({
      mutationFn: ({ artifactId, ...input }: UpdateArtifactInput & { artifactId: string }) => updateArtifact(projectId, artifactId, input),
      ...opts,
    }),
    remove: useMutation({ mutationFn: (artifactId: string) => deleteArtifact(projectId, artifactId), ...opts }),
    pin: useMutation({
      mutationFn: ({ artifactId, pinned }: { artifactId: string; pinned: boolean }) => setArtifactPinned(projectId, artifactId, pinned),
      ...opts,
    }),
    restore: useMutation({
      mutationFn: ({ artifactId, version }: { artifactId: string; version: number }) => restoreArtifactVersion(projectId, artifactId, version),
      ...opts,
    }),
  };
}
