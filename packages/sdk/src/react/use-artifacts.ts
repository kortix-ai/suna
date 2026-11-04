'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ApiError } from '../core/http/api-client';
import {
  createArtifact,
  createArtifactComment,
  deleteArtifact,
  deleteArtifactComment,
  editArtifactComment,
  getArtifact,
  getArtifactCommentContext,
  listArtifactTypes,
  listArtifactComments,
  listArtifactActivity,
  listArtifactVersions,
  listArtifacts,
  readArtifactFile,
  readArtifactCommentScreenshot,
  replyArtifactComment,
  saveArtifact,
  shareArtifactPath,
  restoreArtifactVersion,
  setArtifactPinned,
  setArtifactCommentStatus,
  sendArtifactComments,
  updateArtifact,
  type ArtifactDetail,
  type ArtifactComment,
  type ArtifactCommentMark,
  type ArtifactCommentStatus,
  type ArtifactCommentThread,
  type ArtifactCommentBodyInput,
  type ReplyArtifactCommentInput,
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

/**
 * Comment reads retry at most once, and only where a retry can help. A 4xx is
 * an answer and is never retried. The transport already retries a GET twice on
 * 502/503/504 and on a network failure (`makeRequest`), so those get no second
 * round here: one 503 costs 3 requests, not 12. Any other 5xx gets one retry.
 * The 10 s poll heals the rest.
 */
const TRANSPORT_RETRIED_STATUSES = new Set([502, 503, 504]);
function commentReadRetry(failureCount: number, error: unknown): boolean {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return failureCount < 1 && typeof status === 'number' && status >= 500 && !TRANSPORT_RETRIED_STATUSES.has(status);
}

/**
 * The client-only `optimistic: true` marker. It sits on a thread or comment
 * whose shown state the server has not confirmed yet. The server never sends it.
 */
type Optimistic = { optimistic?: true };
type CommentEntry = ArtifactComment & Optimistic;
type ThreadEntry = Omit<ArtifactCommentThread, 'comments'> & Optimistic & { comments: CommentEntry[] };

const THREAD_LIST_FILTERS = new Set(['open', 'resolved', 'all']);
let clientSequence = 0;
/** Server ids are UUIDs, so a client id can never name a real thread or comment. */
const clientId = (kind: 'thread' | 'comment') => `optimistic-${kind}-${Date.now().toString(36)}-${(clientSequence++).toString(36)}`;
const admits = (filter: string, status: ArtifactCommentStatus) => filter === 'all' || filter === status;
const commentsOf = (thread: ThreadEntry): CommentEntry[] => thread.comments ?? [];

/** `marker` true sets the field; undefined removes it, so a confirmed item carries no key at all. */
function marked<T extends Optimistic>(item: T, marker: true | undefined): T {
  const { optimistic: _previous, ...rest } = item;
  return (marker ? { ...rest, optimistic: true } : rest) as T;
}

/** Put a thread where the server would list it: replaced in place, inserted in creation order, or removed when the list's status filter excludes it. */
function placeThread(threads: ThreadEntry[], filter: string, thread: ThreadEntry): ThreadEntry[] {
  const at = threads.findIndex((item) => item.thread_id === thread.thread_id);
  if (!admits(filter, thread.status)) return at < 0 ? threads : threads.filter((item) => item.thread_id !== thread.thread_id);
  if (at >= 0) return threads.map((item, index) => (index === at ? thread : item));
  const next = threads.findIndex((item) => item.created_at > thread.created_at
    || (item.created_at === thread.created_at && item.thread_id > thread.thread_id));
  return next < 0 ? [...threads, thread] : [...threads.slice(0, next), thread, ...threads.slice(next)];
}

/**
 * A write's answer has `position: null, outdated: false`: the server reads the
 * document text only for a list, and a read-back text position is never that
 * pair. So that pair means "not computed". The cached copy's `position` and
 * `outdated` stay until the next list read. A thread with no cached copy keeps
 * the server's value.
 */
function keepPosition(saved: ThreadEntry, cached: ThreadEntry | undefined): ThreadEntry {
  if (!cached || saved.position !== null || saved.outdated) return saved;
  return { ...saved, position: cached.position, outdated: cached.outdated };
}

/** Server comments first; a pending reply the server copy does not contain yet stays at the end. */
function keepPendingComments(saved: CommentEntry[] | undefined, current: CommentEntry[]): CommentEntry[] {
  const ids = new Set((saved ?? []).map((item) => item.comment_id));
  return [...(saved ?? []), ...current.filter((item) => item.optimistic && !ids.has(item.comment_id) && item.comment_id.startsWith('optimistic-'))];
}

/** A comment the viewer just wrote. The author is a placeholder: the hook does not know the viewer. No action may target it yet. */
function pendingComment(commentId: string, threadId: string, input: { body: string; marks?: ArtifactCommentMark[] }, at: string): CommentEntry {
  return {
    comment_id: commentId, thread_id: threadId, author_user_id: null, author_session_id: null,
    author: { kind: 'user', user_id: '', name: '' }, body: input.body, mentions: [], marks: input.marks ?? [],
    screenshot_key: null, created_at: at, edited_at: null, deleted_at: null, can_edit: false, can_delete: false, optimistic: true,
  };
}

/** Private image bytes are fetched for this mounted comment and discarded on unmount. */
export function useArtifactCommentScreenshot(
  projectId: string | null | undefined,
  artifactId: string | null | undefined,
  commentId: string | null | undefined,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: [
      ...qk.project.artifactComments(projectId ?? "", artifactId ?? ""),
      "screenshot",
      commentId ?? "",
    ],
    queryFn: ({ signal }) =>
      readArtifactCommentScreenshot(
        ...commentScope(projectId, artifactId),
        commentId!,
        { signal },
      ),
    enabled:
      options.enabled !== false && !!projectId && !!artifactId && !!commentId,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/**
 * Threads and their writes. Every mounted thread list of this Artifact shows a
 * write at once, before the server answers:
 *
 * - `create` adds a thread and its first comment;
 * - `reply` adds a comment;
 * - `setStatus` flips `status` and `resolved_at`;
 * - `edit` changes `body` and sets `edited_at`;
 * - `remove` turns the comment into a tombstone (`deleted_at` set, `body` empty).
 *
 * Each changed thread or comment carries the client-only field
 * `optimistic: true` until the server answers. Then the server's copy replaces
 * it and the field is gone. A write's answer carries no text position, so a
 * known thread keeps its cached `position` and `outdated` until the next list
 * read. When the write fails, the change is rolled back and
 * the returned promise rejects as before. A new thread or reply has a client id
 * that starts with `optimistic-`, `can_reply`/`can_resolve`/`can_edit`/
 * `can_delete` false, and a placeholder author (`user_id: ''`, `name: ''`):
 * render the viewer as its author, and allow no action on it until it is
 * confirmed. Each write that reached the server refreshes the Comments and
 * Activity reads once the last concurrent write settles. Historical
 * (`version`) lists are read-only and never change optimistically.
 */
export function useArtifactComments(
  projectId: string | null | undefined,
  artifactId: string | null | undefined,
  options: { status?: ArtifactCommentStatus | 'all'; version?: string; enabled?: boolean } = {},
) {
  const client = useQueryClient();
  const status = options.status ?? 'open';
  const query = useQuery({
    queryKey: qk.project.artifactComments(projectId ?? '', artifactId ?? '', status, options.version),
    queryFn: (): Promise<ThreadEntry[]> => listArtifactComments(...commentScope(projectId, artifactId), { status, ...(options.version ? { version: options.version } : {}) }),
    enabled: options.enabled !== false && !!projectId && !!artifactId,
    ...contract('inventory'),
    retry: commentReadRetry,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: qk.project.artifactComments(projectId ?? '', artifactId ?? '') }),
    client.invalidateQueries({ queryKey: qk.project.artifactActivity(projectId ?? '', artifactId ?? '') }),
  ]);
  const writeScope = (): [string, string] => {
    if (options.version) throw new ApiError('Historical Artifact comments are read-only', { status: 403, code: 'artifact_comments_read_only' });
    return commentScope(projectId, artifactId);
  };
  // Optimistic state lives in every current thread list of this Artifact: `[...scope, 'open' | 'resolved' | 'all']`.
  // The context (`[...scope, 'context', …]`), screenshots and historical lists share the prefix and are left alone.
  const scopeKey = qk.project.artifactComments(projectId ?? '', artifactId ?? '');
  const lists = {
    queryKey: scopeKey,
    predicate: (entry: { queryKey: readonly unknown[] }) =>
      entry.queryKey.length === scopeKey.length + 1 && THREAD_LIST_FILTERS.has(String(entry.queryKey[scopeKey.length])),
  };
  const writeKey = ['artifact-comment-write', projectId ?? '', artifactId ?? ''];
  const optimisticWrites = !options.version && !!projectId && !!artifactId;
  const patchLists = (update: (threads: ThreadEntry[], filter: string) => ThreadEntry[]) => {
    for (const [key, threads] of client.getQueriesData<ThreadEntry[]>(lists)) {
      if (Array.isArray(threads)) client.setQueryData<ThreadEntry[]>(key, update(threads, String(key[scopeKey.length])));
    }
  };
  const patchComment = (threadId: string, commentId: string, update: (comment: CommentEntry) => CommentEntry) =>
    patchLists((threads) => threads.map((thread) => thread.thread_id !== threadId ? thread
      : { ...thread, comments: commentsOf(thread).map((item) => item.comment_id === commentId ? update(item) : item) }));
  const findThread = (threadId: string) => {
    for (const [, threads] of client.getQueriesData<ThreadEntry[]>(lists)) {
      const found = Array.isArray(threads) ? threads.find((thread) => thread.thread_id === threadId) : undefined;
      if (found) return found;
    }
    return undefined;
  };
  const findComment = (threadId: string, commentId: string) => {
    const thread = findThread(threadId);
    return thread ? commentsOf(thread).find((item) => item.comment_id === commentId) : undefined;
  };
  // A poll that lands mid-write would overwrite the optimistic state with the pre-write list.
  const hold = () => client.cancelQueries(lists);
  // `pending` is undefined when the write never left the client (a historical list): nothing to refresh.
  // Only the last concurrent write refreshes, so a refetch never drops another write's pending item.
  const settled = (pending: unknown) => {
    if (pending && client.isMutating({ mutationKey: writeKey }) <= 1) void refresh();
  };
  const create = useMutation({
    mutationKey: writeKey,
    mutationFn: (input: CreateArtifactCommentInput) => createArtifactComment(...writeScope(), input),
    onMutate: async (input) => {
      if (!optimisticWrites) return undefined;
      await hold();
      const threadId = clientId('thread');
      const at = new Date().toISOString();
      const thread: ThreadEntry = {
        thread_id: threadId, artifact_id: artifactId!, project_id: projectId!, anchor: input.anchor, anchor_version: input.anchor.version,
        created_by_user_id: null, created_by_session_id: null, status: 'open',
        resolved_by_user_id: null, resolved_by_session_id: null, resolved_at: null,
        agent_state: 'none', agent_error: null, sent_session_id: null, sent_at: null, created_at: at, updated_at: at,
        comments: [pendingComment(clientId('comment'), threadId, input, at)], outdated: false, position: null,
        can_reply: false, can_resolve: false, optimistic: true,
      };
      // The server stamps the newest created_at, so a new thread is last, whatever the client clock says.
      patchLists((threads, filter) => admits(filter, 'open') ? [...threads, thread] : threads);
      return { threadId };
    },
    onSuccess: (saved, _input, pending) => {
      if (!pending) return;
      // A list read can land while the write is in flight and already hold the new thread with its position.
      patchLists((threads, filter) => placeThread(threads.filter((thread) => thread.thread_id !== pending.threadId), filter,
        keepPosition(saved, threads.find((thread) => thread.thread_id === saved.thread_id))));
    },
    onError: (_error, _input, pending) => {
      if (pending) patchLists((threads) => threads.filter((thread) => thread.thread_id !== pending.threadId));
    },
    onSettled: (_data, _error, _input, pending) => settled(pending),
  });
  const reply = useMutation({
    mutationKey: writeKey,
    mutationFn: ({ threadId, input }: { threadId: string; input: ReplyArtifactCommentInput }) =>
      replyArtifactComment(...writeScope(), threadId, input),
    onMutate: async ({ threadId, input }) => {
      if (!optimisticWrites) return undefined;
      await hold();
      const commentId = clientId('comment');
      const comment = pendingComment(commentId, threadId, input, new Date().toISOString());
      patchLists((threads) => threads.map((thread) => thread.thread_id === threadId ? { ...thread, comments: [...commentsOf(thread), comment] } : thread));
      return { threadId, commentId };
    },
    onSuccess: (saved, _variables, pending) => {
      if (!pending) return;
      patchLists((threads) => threads.map((thread) => {
        if (thread.thread_id !== pending.threadId) return thread;
        const rest = commentsOf(thread).filter((item) => item.comment_id !== pending.commentId && item.comment_id !== saved.comment_id);
        return { ...thread, comments: [...rest, saved] };
      }));
    },
    onError: (_error, _variables, pending) => {
      if (!pending) return;
      patchLists((threads) => threads.map((thread) => thread.thread_id !== pending.threadId ? thread
        : { ...thread, comments: commentsOf(thread).filter((item) => item.comment_id !== pending.commentId) }));
    },
    onSettled: (_data, _error, _variables, pending) => settled(pending),
  });
  const setStatus = useMutation({
    mutationKey: writeKey,
    mutationFn: ({ threadId, status }: { threadId: string; status: ArtifactCommentStatus }) =>
      setArtifactCommentStatus(...writeScope(), threadId, status),
    onMutate: async ({ threadId, status }) => {
      if (!optimisticWrites) return undefined;
      await hold();
      const before = findThread(threadId);
      if (before) {
        const at = new Date().toISOString();
        const flip = (thread: ThreadEntry): ThreadEntry => ({
          ...thread, status, resolved_at: status === 'resolved' ? at : null,
          resolved_by_user_id: null, resolved_by_session_id: null, updated_at: at, optimistic: true,
        });
        patchLists((threads, filter) => placeThread(threads, filter, flip(threads.find((thread) => thread.thread_id === threadId) ?? before)));
      }
      return { threadId, before };
    },
    onSuccess: (saved, _variables, pending) => {
      if (!pending) return;
      patchLists((threads, filter) => {
        const current = threads.find((thread) => thread.thread_id === pending.threadId);
        return placeThread(threads, filter, keepPosition(
          { ...saved, comments: keepPendingComments(saved.comments, current ? commentsOf(current) : []) }, current ?? pending.before));
      });
    },
    onError: (_error, _variables, pending) => {
      const before = pending?.before;
      if (!before) return;
      patchLists((threads, filter) => {
        const current = threads.find((thread) => thread.thread_id === before.thread_id);
        const restored = current ? marked({
          ...current, status: before.status, resolved_at: before.resolved_at, resolved_by_user_id: before.resolved_by_user_id,
          resolved_by_session_id: before.resolved_by_session_id, updated_at: before.updated_at,
        }, before.optimistic) : before;
        return placeThread(threads, filter, restored);
      });
    },
    onSettled: (_data, _error, _variables, pending) => settled(pending),
  });
  const edit = useMutation({
    mutationKey: writeKey,
    mutationFn: ({ threadId, commentId, input }: { threadId: string; commentId: string; input: ArtifactCommentBodyInput }) =>
      editArtifactComment(...writeScope(), threadId, commentId, input),
    onMutate: async ({ threadId, commentId, input }) => {
      if (!optimisticWrites) return undefined;
      await hold();
      const before = findComment(threadId, commentId);
      const at = new Date().toISOString();
      if (before) patchComment(threadId, commentId, (comment) => ({ ...comment, body: input.body, edited_at: at, optimistic: true }));
      return { threadId, commentId, before };
    },
    onSuccess: (saved, _variables, pending) => {
      if (pending) patchComment(pending.threadId, pending.commentId, () => saved);
    },
    onError: (_error, _variables, pending) => {
      const before = pending?.before;
      if (pending && before) patchComment(pending.threadId, pending.commentId, () => before);
    },
    onSettled: (_data, _error, _variables, pending) => settled(pending),
  });
  const remove = useMutation({
    mutationKey: writeKey,
    mutationFn: ({ threadId, commentId }: { threadId: string; commentId: string }) =>
      deleteArtifactComment(...writeScope(), threadId, commentId),
    onMutate: async ({ threadId, commentId }) => {
      if (!optimisticWrites) return undefined;
      await hold();
      const before = findComment(threadId, commentId);
      const at = new Date().toISOString();
      if (before) patchComment(threadId, commentId, (comment) => ({
        ...comment, body: '', mentions: [], marks: [], screenshot_key: null, screenshot_url: null,
        deleted_at: at, can_edit: false, can_delete: false, optimistic: true,
      }));
      return { threadId, commentId, before };
    },
    onSuccess: (saved, _variables, pending) => {
      if (pending) patchComment(pending.threadId, pending.commentId, () => saved);
    },
    onError: (_error, _variables, pending) => {
      const before = pending?.before;
      if (pending && before) patchComment(pending.threadId, pending.commentId, () => before);
    },
    onSettled: (_data, _error, _variables, pending) => settled(pending),
  });
  const send = useMutation({
    mutationFn: (input: SendArtifactCommentsInput) => sendArtifactComments(...writeScope(), input),
    onSuccess: refresh,
  });
  return {
    ...query,
    create: create.mutateAsync,
    reply: (threadId: string, input: ReplyArtifactCommentInput) => reply.mutateAsync({ threadId, input }),
    setStatus: (threadId: string, status: ArtifactCommentStatus) => setStatus.mutateAsync({ threadId, status }),
    edit: (threadId: string, commentId: string, input: ArtifactCommentBodyInput) => edit.mutateAsync({ threadId, commentId, input }),
    remove: (threadId: string, commentId: string) => remove.mutateAsync({ threadId, commentId }),
    send: send.mutateAsync,
    isWriting: create.isPending || reply.isPending || setStatus.isPending || edit.isPending || remove.isPending || send.isPending,
  };
}

/** Permissions and mention choices share the comments cache prefix, so writes refresh their counts and target. */
export function useArtifactCommentContext(
  projectId: string | null | undefined,
  artifactId: string | null | undefined,
  options: { version?: string; agent?: string; enabled?: boolean } = {},
) {
  const params = { ...(options.version ? { version: options.version } : {}), ...(options.agent ? { agent: options.agent } : {}) };
  return useQuery({
    queryKey: qk.project.artifactCommentContext(projectId ?? '', artifactId ?? '', params),
    queryFn: () => getArtifactCommentContext(...commentScope(projectId, artifactId), params),
    enabled: options.enabled !== false && !!projectId && !!artifactId,
    ...contract('inventory'),
    retry: commentReadRetry,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

/** Cursor pages stay in the SDK cache. Comment writes refresh the loaded pages through their shared prefix. */
export function useInfiniteArtifactActivity(
  projectId: string | null | undefined,
  artifactId: string | null | undefined,
  options: { limit?: number; enabled?: boolean } = {},
) {
  const limit = options.limit ?? 50;
  const query = useInfiniteQuery({
    queryKey: qk.project.artifactActivityInfinite(projectId ?? '', artifactId ?? '', limit),
    queryFn: ({ pageParam }) => listArtifactActivity(...commentScope(projectId, artifactId), { limit, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: options.enabled !== false && !!projectId && !!artifactId,
    ...contract('inventory'),
    retry: commentReadRetry,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
  const seen = new Set<string>();
  const items = (query.data?.pages.flatMap((page) => page.items) ?? []).filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  return { ...query, items, olderVersions: query.data?.pages.some((page) => page.older_versions) ?? false };
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
    retry: commentReadRetry,
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
