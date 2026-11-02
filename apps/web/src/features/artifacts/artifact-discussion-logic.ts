import type {
  ArtifactActivityItem,
  ArtifactComment,
  ArtifactCommentContext,
  ArtifactCommentThread,
} from '@kortix/sdk';

export type CommentFilter = 'open' | 'resolved' | 'all';

export function threadDeleted(thread: ArtifactCommentThread): boolean {
  return !thread.comments[0] || thread.comments[0].deleted_at !== null;
}

/** Who opened the thread, as a re-anchoring budget key: the person, else the agent session. */
export function threadAuthor(thread: Pick<ArtifactCommentThread, 'created_by_user_id' | 'created_by_session_id'>): string {
  return thread.created_by_user_id ? `user:${thread.created_by_user_id}` : `session:${thread.created_by_session_id ?? ''}`;
}

/** Open and resolved counts for the filter. A deleted root counts in neither: its tombstone lists only under All. */
export function threadCounts(threads: readonly ArtifactCommentThread[]) {
  let open = 0;
  let resolved = 0;
  for (const thread of threads) {
    if (threadDeleted(thread)) continue;
    if (thread.status === 'open') open++;
    else resolved++;
  }
  return { open, resolved };
}

/**
 * Who resolved a thread: a person from the context roster, an agent session, or a comment author
 * of the thread. The fallback names apply when the resolver left the roster.
 */
export function resolverName(
  thread: ArtifactCommentThread,
  context: Pick<ArtifactCommentContext, 'people' | 'agents'> | undefined,
  fallback: { person: string; agent: string },
): string | null {
  const userId = thread.resolved_by_user_id;
  if (userId) {
    const person = context?.people.find((candidate) => candidate.user_id === userId);
    if (person) return person.name;
    for (const comment of thread.comments)
      if (comment.author.kind === 'user' && comment.author.user_id === userId)
        return comment.author.name;
    return fallback.person;
  }
  const sessionId = thread.resolved_by_session_id;
  if (sessionId) {
    const agent = context?.agents.find((candidate) => candidate.session_id === sessionId);
    if (agent) return agent.name;
    for (const comment of thread.comments)
      if (comment.author.kind === 'session' && comment.author.session_id === sessionId)
        return comment.author.agent_name;
    return fallback.agent;
  }
  return null;
}

/**
 * The agent a thread's failed delivery went to: the first agent or session mention of the latest
 * comment that names one. A reply without a mention goes to the agents earlier comments reached,
 * so the search walks back past it. Undefined when no comment names an agent: the caller uses the
 * Send target.
 */
export function deliveryAgent(thread: Pick<ArtifactCommentThread, 'comments'>): string | undefined {
  for (let index = thread.comments.length - 1; index >= 0; index--) {
    const comment = thread.comments[index]!;
    if (comment.deleted_at) continue;
    for (const mention of comment.mentions ?? [])
      if (mention.kind !== 'user') return mention.agent_name;
  }
  return undefined;
}

/**
 * The server answered the request: its error carries an HTTP status. A network failure or a
 * timeout carries none, and the server may still finish that request.
 */
export function serverAnswered(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object' || !('status' in cause)) return false;
  const { status } = cause;
  return typeof status === 'number' && status >= 100 && status <= 599;
}

/** The quoted passage of a thread, or '' for a whole-Artifact comment. */
export function threadQuote(thread: Pick<ArtifactCommentThread, 'anchor'>): string {
  const anchor = thread.anchor;
  return anchor.type === 'text' ? anchor.quote : 'snippet' in anchor ? anchor.snippet : '';
}

/**
 * A thread with more than 4 comments shows its first comment, a "N more replies" control,
 * then its last 2 comments. `hidden` is 0 when every comment shows.
 */
export function collapseComments<T>(comments: readonly T[], expanded: boolean) {
  if (expanded || comments.length <= 4)
    return { head: [...comments], hidden: 0, tail: [] as T[] };
  return { head: comments.slice(0, 1), hidden: comments.length - 3, tail: comments.slice(-2) };
}

/** The muted second line of an Activity row: the reply it names, else the passage, else the first comment. */
export function activityExcerpt(
  item: ArtifactActivityItem,
  threads: readonly ArtifactCommentThread[],
): string | null {
  const threadId = activityThreadId(item);
  const thread = threadId ? threads.find((candidate) => candidate.thread_id === threadId) : null;
  if (!thread) return null;
  const commentId = typeof item.data.comment_id === 'string' ? item.data.comment_id : null;
  const named =
    item.type === 'replied' && commentId
      ? thread.comments.find((comment) => comment.comment_id === commentId)
      : undefined;
  const text =
    (named && !named.deleted_at ? named.body : '') ||
    threadQuote(thread) ||
    (thread.comments[0] && !thread.comments[0].deleted_at ? thread.comments[0].body : '');
  const line = text.replace(/\s+/g, ' ').trim();
  return line || null;
}

/**
 * The SDK marks a thread or comment the server has not confirmed with the client-only
 * `optimistic: true`. A new one also has an id that starts with `optimistic-`.
 */
export function isOptimistic(item: object): boolean {
  return (item as { optimistic?: unknown }).optimistic === true;
}

/**
 * Comments that arrived since the previous read, for the polite live region. The viewer's own
 * comments are skipped: an unconfirmed one, one by `viewerId`, and one the viewer can edit
 * (`can_edit` is true only for the author).
 */
export function arrivedComments(
  seen: ReadonlySet<string>,
  threads: readonly ArtifactCommentThread[],
  viewerId?: string | null,
): ArtifactComment[] {
  const arrived: ArtifactComment[] = [];
  for (const thread of threads)
    for (const comment of thread.comments)
      if (
        !seen.has(comment.comment_id) &&
        !comment.deleted_at &&
        !isOptimistic(comment) &&
        !comment.comment_id.startsWith('optimistic-') &&
        comment.can_edit !== true &&
        !(viewerId && comment.author_user_id === viewerId)
      )
        arrived.push(comment);
  return arrived;
}

export function groupCommentThreads(
  threads: readonly ArtifactCommentThread[],
  filter: CommentFilter,
) {
  const visible = threads.filter(
    (thread) => filter === 'all' || (thread.status === filter && !threadDeleted(thread)),
  );
  const stable = (a: ArtifactCommentThread, b: ArtifactCommentThread) =>
    a.created_at.localeCompare(b.created_at) || a.thread_id.localeCompare(b.thread_id);
  return {
    current: visible
      .filter((thread) => !thread.outdated)
      .sort(
        (a, b) => (a.position?.start ?? Infinity) - (b.position?.start ?? Infinity) || stable(a, b),
      ),
    outdated: visible.filter((thread) => thread.outdated).sort(stable),
  };
}

export function groupActivityDays(
  items: readonly ArtifactActivityItem[],
): { key: string; day: Date; items: ArtifactActivityItem[] }[] {
  const groups = new Map<string, { key: string; day: Date; items: ArtifactActivityItem[] }>();
  for (const item of items) {
    const at = new Date(item.at);
    const day = new Date(at.getFullYear(), at.getMonth(), at.getDate());
    const key = String(day.getTime());
    if (!groups.has(key)) groups.set(key, { key, day, items: [] });
    groups.get(key)!.items.push(item);
  }
  return [...groups.values()];
}

export function activityThreadId(item: ArtifactActivityItem): string | null {
  return [
    'thread_opened',
    'replied',
    'resolved',
    'reopened',
    'comment_deleted',
    'sent_to_agent',
  ].includes(item.type) &&
    typeof item.data.thread_id === 'string' &&
    item.data.thread_id
    ? item.data.thread_id
    : null;
}

export function activityVersionId(item: ArtifactActivityItem): string | null {
  if (!['saved', 'restored'].includes(item.type)) return null;
  const value = item.data.version ?? item.data.commit_id;
  return typeof value === 'string' && value ? value : null;
}

export function commentEnterAction(
  event: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number },
  hasMention: boolean,
) {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return 'ignore';
  if (event.shiftKey) return 'newline';
  return hasMention ? 'mention' : 'submit';
}

export interface MentionRange {
  start: number;
  end: number;
  query: string;
}

export function mentionAtCaret(value: string, caret: number): MentionRange | null {
  const match = /(?:^|[\s([{])@([^\s@]*)$/u.exec(value.slice(0, caret));
  if (!match) return null;
  const query = match[1]!;
  return { start: caret - query.length - 1, end: caret, query };
}

export function replaceMention(value: string, range: MentionRange, token: string) {
  const after = value.slice(range.end);
  const space = after.startsWith(' ') ? '' : ' ';
  return {
    value: `${value.slice(0, range.start)}${token}${space}${after}`,
    caret: range.start + token.length + 1,
  };
}
