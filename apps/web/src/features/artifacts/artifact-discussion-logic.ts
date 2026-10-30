import type { ArtifactActivityItem, ArtifactCommentThread } from '@kortix/sdk';

export type CommentFilter = 'open' | 'resolved' | 'all';

export function threadDeleted(thread: ArtifactCommentThread): boolean {
  return !thread.comments[0] || thread.comments[0].deleted_at !== null;
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
