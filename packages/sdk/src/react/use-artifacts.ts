'use client';

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  createArtifact,
  deleteArtifact,
  getArtifact,
  listArtifactTypes,
  listArtifactVersions,
  listArtifacts,
  readArtifactFile,
  saveArtifact,
  shareArtifactPath,
  restoreArtifactVersion,
  setArtifactPinned,
  updateArtifact,
  type ArtifactDetail,
  type ListArtifactsOptions,
  type PublishArtifactInput,
  type SaveArtifactInput,
  type ShareArtifactPathInput,
  type UpdateArtifactInput,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/** The project's artifacts the caller may view (flag `artifacts`), newest change first. */
export function useArtifacts(
  projectId: string | null | undefined,
  filter: ListArtifactsOptions = {},
) {
  return useQuery({
    queryKey: qk.project.artifactList(projectId ?? '', JSON.stringify(filter)),
    queryFn: () => listArtifacts(projectId as string, filter),
    enabled: !!projectId,
    // A new filter keeps the cards (and their loaded previews) until the next list arrives.
    placeholderData: (prev) => prev,
    ...contract('inventory'),
  });
}

/** One artifact now, or at a version (a Files commit), with its files and a signed `view_url`. */
export function useArtifact(projectId: string | null | undefined, artifactId: string | null | undefined, version?: string) {
  return useQuery({
    queryKey: qk.project.artifact(projectId ?? '', artifactId ?? '', version ?? 'current'),
    queryFn: () => getArtifact(projectId as string, artifactId as string, version ? { version } : {}),
    enabled: !!projectId && !!artifactId,
    ...contract('inventory'),
  });
}

/** The text a doc shows: the entry at `version.id` (an old version) or at `entry_version` (now). */
function textVersion(artifact: Pick<ArtifactDetail, 'entry_version' | 'version'>): string {
  return artifact.version.id ?? artifact.entry_version ?? 'none';
}

/**
 * A doc's Markdown. Keyed on the entry version, so it never changes and never
 * goes stale: a save moves the version, and the next open reads the new key.
 */
export function useArtifactText(projectId: string | null | undefined, artifact: ArtifactDetail | null | undefined) {
  return useQuery({
    queryKey: qk.project.artifactText(projectId ?? '', artifact?.artifact_id ?? '', artifact ? textVersion(artifact) : ''),
    queryFn: () => readText(projectId as string, artifact as ArtifactDetail),
    enabled: !!projectId && !!artifact,
    staleTime: Infinity,
  });
}

function readText(projectId: string, artifact: ArtifactDetail): Promise<string> {
  return readArtifactFile(projectId, artifact.artifact_id, artifact.version.id ? { version: artifact.version.id } : {}).then((blob) => blob.text());
}

/**
 * Warm everything opening an artifact reads: its detail and, for a doc, its
 * Markdown. Hosts call it ahead of a click (a preloader, a hover), so the
 * viewer opens without a request.
 */
export async function prefetchArtifact(queryClient: QueryClient, projectId: string, artifactId: string): Promise<void> {
  const detail = await queryClient.fetchQuery({
    queryKey: qk.project.artifact(projectId, artifactId),
    queryFn: () => getArtifact(projectId, artifactId),
    ...contract('inventory'),
  });
  if (detail.type !== 'doc') return;
  await queryClient.prefetchQuery({
    queryKey: qk.project.artifactText(projectId, artifactId, textVersion(detail)),
    queryFn: () => readText(projectId, detail),
    staleTime: Infinity,
  });
}

/** After a doc save: the Markdown just written is the text of the new entry version. */
export function seedSavedText(
  queryClient: QueryClient,
  projectId: string,
  saved: Pick<ArtifactDetail, 'artifact_id' | 'type' | 'entry' | 'entry_version'>,
  input: Pick<SaveArtifactInput, 'files'>,
): void {
  const content = input.files[saved.entry]?.content;
  if (saved.type !== 'doc' || typeof content !== 'string' || !saved.entry_version) return;
  queryClient.setQueryData(qk.project.artifactText(projectId, saved.artifact_id, saved.entry_version), content);
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
    share: useMutation({ mutationFn: (input: ShareArtifactPathInput) => shareArtifactPath(projectId, input), ...opts }),
    save: useMutation({
      mutationFn: ({ artifactId, ...input }: SaveArtifactInput & { artifactId: string }) => saveArtifact(projectId, artifactId, input),
      onSuccess: (saved, input) => {
        seedSavedText(qc, projectId, saved, input);
        return refresh();
      },
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
      mutationFn: ({ artifactId, version }: { artifactId: string; version: string }) => restoreArtifactVersion(projectId, artifactId, version),
      ...opts,
    }),
  };
}
