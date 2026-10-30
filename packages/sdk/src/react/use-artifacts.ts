'use client';

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  createArtifact,
  createArtifactComment,
  deleteArtifact,
  deleteArtifactComment,
  editArtifactComment,
  getArtifact,
  listArtifactTypes,
  listArtifactComments,
  listArtifactActivity,
  listArtifactVersions,
  listArtifacts,
  readArtifactFile,
  replyArtifactComment,
  saveArtifact,
  shareArtifactPath,
  restoreArtifactVersion,
  setArtifactPinned,
  setArtifactCommentStatus,
  sendArtifactComments,
  updateArtifact,
  type ArtifactDetail,
  type ArtifactCommentStatus,
  type ArtifactCommentBodyInput,
  type CreateArtifactCommentInput,
  type SendArtifactCommentsInput,
  type ListArtifactsOptions,
  type PublishArtifactInput,
  type SaveArtifactInput,
  type ShareArtifactPathInput,
  type UpdateArtifactInput,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

function commentScope(projectId: string | null | undefined, artifactId: string | null | undefined): [string, string] {
  if (!projectId || !artifactId) throw new Error('An Artifact comment needs a project and Artifact id');
  return [projectId, artifactId];
}

/** Threads and their writes. Each successful write refreshes both mounted tabs. */
export function useArtifactComments(
  projectId: string | null | undefined,
  artifactId: string | null | undefined,
  options: { status?: ArtifactCommentStatus | 'all'; enabled?: boolean } = {},
) {
  const client = useQueryClient();
  const status = options.status ?? 'open';
  const query = useQuery({
    queryKey: qk.project.artifactComments(projectId ?? '', artifactId ?? '', status),
    queryFn: () => listArtifactComments(...commentScope(projectId, artifactId), { status }),
    enabled: options.enabled !== false && !!projectId && !!artifactId,
    ...contract('inventory'),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: qk.project.artifactComments(projectId ?? '', artifactId ?? '') }),
    client.invalidateQueries({ queryKey: qk.project.artifactActivity(projectId ?? '', artifactId ?? '') }),
  ]);
  const create = useMutation({
    mutationFn: (input: CreateArtifactCommentInput) => createArtifactComment(...commentScope(projectId, artifactId), input),
    onSuccess: refresh,
  });
  const reply = useMutation({
    mutationFn: ({ threadId, input }: { threadId: string; input: ArtifactCommentBodyInput }) =>
      replyArtifactComment(...commentScope(projectId, artifactId), threadId, input),
    onSuccess: refresh,
  });
  const setStatus = useMutation({
    mutationFn: ({ threadId, status }: { threadId: string; status: ArtifactCommentStatus }) =>
      setArtifactCommentStatus(...commentScope(projectId, artifactId), threadId, status),
    onSuccess: refresh,
  });
  const edit = useMutation({
    mutationFn: ({ threadId, commentId, input }: { threadId: string; commentId: string; input: ArtifactCommentBodyInput }) =>
      editArtifactComment(...commentScope(projectId, artifactId), threadId, commentId, input),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: ({ threadId, commentId }: { threadId: string; commentId: string }) =>
      deleteArtifactComment(...commentScope(projectId, artifactId), threadId, commentId),
    onSuccess: refresh,
  });
  const send = useMutation({
    mutationFn: (input: SendArtifactCommentsInput) => sendArtifactComments(...commentScope(projectId, artifactId), input),
    onSuccess: refresh,
  });
  return {
    ...query,
    create: create.mutateAsync,
    reply: (threadId: string, input: ArtifactCommentBodyInput) => reply.mutateAsync({ threadId, input }),
    setStatus: (threadId: string, status: ArtifactCommentStatus) => setStatus.mutateAsync({ threadId, status }),
    edit: (threadId: string, commentId: string, input: ArtifactCommentBodyInput) => edit.mutateAsync({ threadId, commentId, input }),
    remove: (threadId: string, commentId: string) => remove.mutateAsync({ threadId, commentId }),
    send: send.mutateAsync,
    isWriting: create.isPending || reply.isPending || setStatus.isPending || edit.isPending || remove.isPending || send.isPending,
  };
}

/** One page of activity. Polls while mounted until realtime change pings are available. */
export function useArtifactActivity(
  projectId: string | null | undefined,
  artifactId: string | null | undefined,
  options: { limit?: number; cursor?: string; enabled?: boolean } = {},
) {
  const page = { ...(options.limit === undefined ? {} : { limit: options.limit }), ...(options.cursor === undefined ? {} : { cursor: options.cursor }) };
  return useQuery({
    queryKey: qk.project.artifactActivity(projectId ?? '', artifactId ?? '', page),
    queryFn: () => listArtifactActivity(...commentScope(projectId, artifactId), page),
    enabled: options.enabled !== false && !!projectId && !!artifactId,
    ...contract('inventory'),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

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

/**
 * After a create: the new artifact's detail, and for a doc the Markdown just
 * written, so navigating to it opens without a request.
 */
export function seedCreatedArtifact(
  queryClient: QueryClient,
  projectId: string,
  created: ArtifactDetail,
  input: Pick<PublishArtifactInput, 'files'>,
): void {
  queryClient.setQueryData(qk.project.artifact(projectId, created.artifact_id, 'current'), created);
  seedSavedText(queryClient, projectId, created, input);
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
    create: useMutation({
      mutationFn: (input: PublishArtifactInput) => createArtifact(projectId, input),
      onSuccess: (created, input) => {
        seedCreatedArtifact(qc, projectId, created, input);
        return refresh();
      },
    }),
    share: useMutation({ mutationFn: (input: ShareArtifactPathInput) => shareArtifactPath(projectId, input), ...opts }),
    save: useMutation({
      mutationFn: ({ artifactId, ...input }: SaveArtifactInput & { artifactId: string }) => saveArtifact(projectId, artifactId, input),
      // The editor owns save errors (status line, conflict actions): no second, generic toast.
      onError: () => {},
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
