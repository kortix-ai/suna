import type { ArtifactActivityItem, ArtifactCommentThread } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import {
  activityThreadId,
  activityVersionId,
  commentEnterAction,
  groupActivityDays,
  groupCommentThreads,
  mentionAtCaret,
  replaceMention,
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
