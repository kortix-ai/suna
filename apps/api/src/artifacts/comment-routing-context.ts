type Comment = { comment_id: string; thread_id: string; deleted_at: string | null; mentions: unknown };
type Thread = { thread_id: string; status: 'open' | 'resolved'; created_by_session_id: string | null; comments: Comment[] };
type Event = { data: Record<string, unknown> };
type Command = { status: string; idempotencyKey: string | null; payload: Record<string, unknown> };
type Job = { status: string; payload: Record<string, unknown> };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const terminal = new Set(['failed', 'dead_lettered', 'cancelled']);
export const ARTIFACT_COMMENT_SEND_LIMIT = 100;

export function artifactCommentSendBatch(ids: readonly string[]) {
  return { send_thread_ids: ids.slice(0, ARTIFACT_COMMENT_SEND_LIMIT), send_thread_count: ids.length };
}

export function unaddressedArtifactThreadIds(threads: Thread[], events: Event[], jobs: Job[], commands: Command[]): string[] {
  const byThread = new Map(threads.map((thread) => [thread.thread_id, thread]));
  const comments = new Map(threads.flatMap((thread) => thread.comments.map((comment) => [comment.comment_id, comment] as const)));
  const addressed = new Set<string>();
  const states = new Map<string, string>();
  const state = (key: string, status: string) => { if (!terminal.has(states.get(key) ?? '')) states.set(key, status); };
  for (const command of commands) {
    if (command.idempotencyKey) state(command.idempotencyKey, command.status);
    const digest = command.payload.artifactCommentDigest;
    if (record(digest) && Array.isArray(digest.keys)) for (const key of digest.keys) if (typeof key === 'string') state(key, command.status);
    const reference = command.payload.artifactCommentDelivery;
    if (record(reference) && typeof reference.target_key === 'string') state(reference.target_key, command.status);
  }
  const live = (threadId: string) => {
    const root = byThread.get(threadId)?.comments[0];
    return !!root && !root.deleted_at;
  };
  const origin = (threadIds: string[], recipientKey: string, originId: unknown) => {
    if (originId === undefined) return true;
    if (typeof originId !== 'string') return false;
    const comment = comments.get(originId);
    return !!comment && !comment.deleted_at && threadIds.includes(comment.thread_id) && live(comment.thread_id)
      && Array.isArray(comment.mentions) && comment.mentions.some((mention) => record(mention)
        && (mention.kind === 'session' && `session:${mention.session_id}` === recipientKey || mention.kind === 'agent' && `agent:${mention.agent_name}` === recipientKey));
  };
  const accepted = (key: unknown) => typeof key !== 'string' || !terminal.has(states.get(key) ?? '');
  for (const thread of threads) if (thread.created_by_session_id && live(thread.thread_id)) addressed.add(thread.thread_id);
  for (const event of events) {
    const data = event.data;
    if (typeof data.thread_id !== 'string' || typeof data.session_id !== 'string' || !live(data.thread_id) || !accepted(data.delivery_key)) continue;
    const key = typeof data.recipient_key === 'string' ? data.recipient_key : `session:${data.session_id}`;
    if (origin([data.thread_id], key, data.origin_comment_id)) addressed.add(data.thread_id);
  }
  for (const job of jobs) {
    if (job.status !== 'queued' || !Array.isArray(job.payload.threadIds)) continue;
    const ids = job.payload.threadIds.filter((id): id is string => typeof id === 'string' && byThread.has(id));
    const source = typeof job.payload.commentId === 'string' ? comments.get(job.payload.commentId) : undefined;
    if (job.payload.commentId && (!source || source.deleted_at || !ids.includes(source.thread_id))) continue;
    const targets = Array.isArray(job.payload.targets) ? job.payload.targets : [
      ...(Array.isArray(job.payload.recipients) ? job.payload.recipients : []),
      ...(Array.isArray(source?.mentions) ? source.mentions.filter((mention) => record(mention) && mention.kind !== 'user').map((mention) => {
        const value = mention as Record<string, unknown>;
        return { recipientKey: value.kind === 'session' ? `session:${value.session_id}` : `agent:${value.agent_name}`, originCommentId: source!.comment_id };
      }) : []),
    ];
    for (const target of targets) {
      if (!record(target) || typeof target.recipientKey !== 'string' || ['failed', 'skipped'].includes(String(target.status)) || !accepted(target.createKey ?? target.key)) continue;
      const original = target.originCommentId ?? (!target.implicit && source ? source.comment_id : undefined);
      if (!origin(ids, target.recipientKey, original)) continue;
      for (const id of ids) if (live(id)) addressed.add(id);
    }
  }
  return threads.filter((thread) => thread.status === 'open' && live(thread.thread_id) && !addressed.has(thread.thread_id)).map((thread) => thread.thread_id);
}
