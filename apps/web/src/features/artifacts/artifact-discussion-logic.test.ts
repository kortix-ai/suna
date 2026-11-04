import { ApiError, type ArtifactActivityItem, type ArtifactCommentThread } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import {
  activityExcerpt,
  activityThreadId,
  activityVersionId,
  arrivedComments,
  collapseComments,
  commentEnterAction,
  deliveryAgent,
  groupActivityDays,
  groupCommentThreads,
  mentionAtCaret,
  replaceMention,
  serverAnswered,
  threadCounts,
  threadDeleted,
} from './artifact-discussion-logic';

const thread = (id: string, props: Partial<ArtifactCommentThread> = {}) =>
  ({
    thread_id: id,
    status: 'open',
    created_at: '2026-10-29T12:00:00Z',
    comments: [{ deleted_at: null }],
    outdated: false,
    position: null,
    ...props,
  }) as ArtifactCommentThread;
const event = (
  id: string,
  at: string,
  type: ArtifactActivityItem['type'] = 'saved',
  data: Record<string, unknown> = {},
) =>
  ({
    id,
    at,
    type,
    actor: { kind: 'system', id: null, name: 'System' },
    data,
  }) as ArtifactActivityItem;

describe('Artifact thread groups', () => {
  test('current text follows document order; unanchored and outdated threads stay in stable groups', () => {
    const input = [
      thread('none'),
      thread('later', { position: { start: 40, end: 50 } }),
      thread('old', { outdated: true }),
      thread('early', { position: { start: 4, end: 8 } }),
    ];
    const result = groupCommentThreads(input, 'all');
    expect(result.current.map((t) => t.thread_id)).toEqual(['early', 'later', 'none']);
    expect(result.outdated.map((t) => t.thread_id)).toEqual(['old']);
    expect(input.map((t) => t.thread_id)).toEqual(['none', 'later', 'old', 'early']);
  });
  test('filters apply to both groups and ties use the thread id', () => {
    const input = [
      thread('b'),
      thread('a'),
      thread('done', { status: 'resolved', outdated: true }),
    ];
    expect(groupCommentThreads(input, 'open').current.map((t) => t.thread_id)).toEqual(['a', 'b']);
    expect(groupCommentThreads(input, 'open').outdated).toEqual([]);
    expect(groupCommentThreads(input, 'resolved').outdated.map((t) => t.thread_id)).toEqual([
      'done',
    ]);
  });
  test('a deleted root disables a thread even when later replies exist', () => {
    const deleted = thread('gone', {
      comments: [
        { deleted_at: '2026-10-29T12:00:00Z' },
        { deleted_at: null },
      ] as ArtifactCommentThread['comments'],
    });
    expect(threadDeleted(deleted)).toBe(true);
    expect(threadDeleted(thread('live'))).toBe(false);
    expect(groupCommentThreads([deleted], 'open').current).toEqual([]);
    expect(groupCommentThreads([deleted], 'all').current).toEqual([deleted]);
  });
  test('filter counts skip a deleted root, so Open matches the header badge', () => {
    const deleted = thread('gone', {
      comments: [{ deleted_at: '2026-10-29T12:00:00Z' }] as ArtifactCommentThread['comments'],
    });
    expect(
      threadCounts([thread('a'), thread('b', { status: 'resolved' }), deleted, thread('c')]),
    ).toEqual({ open: 2, resolved: 1 });
  });
  test('a long thread keeps its first and last two comments visible', () => {
    expect(collapseComments([1, 2, 3, 4], false)).toEqual({ head: [1, 2, 3, 4], hidden: 0, tail: [] });
    expect(collapseComments([1, 2, 3, 4, 5, 6], false)).toEqual({ head: [1], hidden: 3, tail: [5, 6] });
    expect(collapseComments([1, 2, 3, 4, 5, 6], true).hidden).toBe(0);
  });
});

describe('Artifact comment announcements', () => {
  const comment = (id: string, extra: Record<string, unknown> = {}) => ({
    comment_id: id,
    deleted_at: null,
    can_edit: false,
    ...extra,
  });
  test('only unseen, live comments by someone else are announced', () => {
    const value = thread('t', {
      comments: [
        comment('seen'),
        comment('mine', { can_edit: true }),
        comment('gone', { deleted_at: '2026-10-29T12:00:00Z' }),
        comment('optimistic-comment-1', { optimistic: true }),
        comment('by-viewer', { author_user_id: 'viewer' }),
        comment('new', { author_user_id: 'other' }),
      ] as unknown as ArtifactCommentThread['comments'],
    });
    expect(
      arrivedComments(new Set(['seen']), [value], 'viewer').map((c) => c.comment_id),
    ).toEqual(['new']);
  });
});

describe('Artifact activity', () => {
  test('groups by local calendar day and retains server order', () => {
    const today = new Date(2026, 9, 29, 14).toISOString();
    const yesterday = new Date(2026, 9, 28, 20).toISOString();
    const groups = groupActivityDays([
      event('new', today),
      event('old', today),
      event('prior', yesterday),
    ]);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([['new', 'old'], ['prior']]);
    expect(groups[0]!.day.getDate()).toBe(29);
  });
  test('only supported event targets produce actions', () => {
    expect(activityThreadId(event('reply', '', 'replied', { thread_id: 'thread' }))).toBe('thread');
    expect(activityThreadId(event('bad', '', 'replied', { thread_id: 12 }))).toBeNull();
    expect(activityVersionId(event('save', '', 'saved', { version: 'vc_saved' }))).toBe('vc_saved');
    expect(activityVersionId(event('rename', '', 'renamed', { version: 'vc_fake' }))).toBeNull();
  });
  test('a thread row names its reply, else its passage, else its first comment', () => {
    const body = (id: string, text: string, deleted: string | null = null) => ({
      comment_id: id,
      body: text,
      deleted_at: deleted,
    });
    const quoted = thread('quoted', {
      anchor: { type: 'text', version: 'v', quote: 'Churn  fell\nto 2.1%', prefix: '', suffix: '' },
      comments: [body('root', 'Which churn?'), body('reply', 'Logo churn.')] as never,
    });
    const plain = thread('plain', {
      anchor: { type: 'none', version: 'v' },
      comments: [body('root', 'Shorten the risks.')] as never,
    });
    const threads = [quoted, plain];
    const reply = event('r', '', 'replied', { thread_id: 'quoted', comment_id: 'reply' });
    expect(activityExcerpt(reply, threads)).toBe('Logo churn.');
    expect(activityExcerpt(event('o', '', 'thread_opened', { thread_id: 'quoted' }), threads)).toBe(
      'Churn fell to 2.1%',
    );
    expect(activityExcerpt(event('p', '', 'resolved', { thread_id: 'plain' }), threads)).toBe(
      'Shorten the risks.',
    );
    expect(activityExcerpt(event('x', '', 'resolved', { thread_id: 'unknown' }), threads)).toBeNull();
    expect(activityExcerpt(event('s', '', 'saved', { version: 'v' }), threads)).toBeNull();
  });
});

describe('comment composer keyboard and mention ranges', () => {
  test('IME and Shift+Enter never submit; a populated mention menu owns Enter first', () => {
    expect(
      commentEnterAction({ key: 'Enter', shiftKey: false, isComposing: true, keyCode: 13 }, true),
    ).toBe('ignore');
    expect(commentEnterAction({ key: 'Enter', shiftKey: false, keyCode: 229 }, false)).toBe(
      'ignore',
    );
    expect(commentEnterAction({ key: 'Enter', shiftKey: true }, true)).toBe('newline');
    expect(commentEnterAction({ key: 'Enter', shiftKey: false }, true)).toBe('mention');
    expect(commentEnterAction({ key: 'Enter', shiftKey: false }, false)).toBe('submit');
    expect(commentEnterAction({ key: 'a', shiftKey: false }, false)).toBe('ignore');
  });
  test('finds a mention at the caret without treating email text as an opening trigger', () => {
    expect(mentionAtCaret('Review @da', 10)).toEqual({ start: 7, end: 10, query: 'da' });
    expect(mentionAtCaret('name@example.test', 12)).toBeNull();
    expect(mentionAtCaret('Review @dana then continue', 12)).toEqual({
      start: 7,
      end: 12,
      query: 'dana',
    });
  });
  test('inserts only the supplied token and preserves trailing text', () => {
    expect(
      replaceMention('Review @da next', { start: 7, end: 10, query: 'da' }, '@dana@example.test'),
    ).toEqual({ value: 'Review @dana@example.test next', caret: 26 });
    expect(replaceMention('@da', { start: 0, end: 3, query: 'da' }, '@dana@example.test')).toEqual({
      value: '@dana@example.test ',
      caret: 19,
    });
  });
});

describe('Delivery retry', () => {
  const comment = (
    id: string,
    mentions: ArtifactCommentThread['comments'][number]['mentions'],
    deleted_at: string | null = null,
  ) => ({ comment_id: id, mentions, deleted_at }) as ArtifactCommentThread['comments'][number];
  test('a failed delivery went to the agent the latest comment that names an agent mentions first', () => {
    const reviewer = comment('root', [
      { kind: 'user', user_id: 'dana' },
      { kind: 'agent', agent_name: 'reviewer' },
      { kind: 'agent', agent_name: 'writer' },
    ]);
    expect(deliveryAgent(thread('t', { comments: [reviewer] }))).toBe('reviewer');
    // A reply that names no agent goes to the agents earlier comments reached.
    const plain = comment('reply', [{ kind: 'user', user_id: 'dana' }]);
    expect(deliveryAgent(thread('t', { comments: [reviewer, plain] }))).toBe('reviewer');
    // A session mention names the agent of the session that made the Artifact.
    const session = comment('later', [{ kind: 'session', session_id: 's', agent_name: 'kortix' }]);
    expect(deliveryAgent(thread('t', { comments: [reviewer, session, plain] }))).toBe('kortix');
    // A deleted comment no longer names its agent.
    const deleted = comment('gone', [{ kind: 'agent', agent_name: 'gone' }], '2026-10-29');
    expect(deliveryAgent(thread('t', { comments: [reviewer, deleted] }))).toBe('reviewer');
    expect(deliveryAgent(thread('t', { comments: [plain] }))).toBeUndefined();
  });
  test('only an HTTP status proves the server answered; a network failure or a timeout has none', () => {
    expect(serverAnswered(new ApiError('could not be sent', { status: 409 }))).toBe(true);
    expect(serverAnswered(new ApiError('Bad gateway', { status: 502 }))).toBe(true);
    expect(serverAnswered(new ApiError('Failed to fetch'))).toBe(false);
    expect(serverAnswered(new ApiError('Request timed out', { code: 'TIMEOUT' }))).toBe(false);
    expect(serverAnswered(new TypeError('Failed to fetch'))).toBe(false);
    expect(serverAnswered({ code: 'artifact_comment_screenshot_limit' })).toBe(false);
    expect(serverAnswered({ status: '409' })).toBe(false);
    expect(serverAnswered(null)).toBe(false);
  });
});
