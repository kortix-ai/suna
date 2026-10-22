import { expect, test } from 'bun:test';
import { detectMentionTrigger, pruneMentions } from './mentions';

test('detects start and mid-text mentions', () => {
  expect(detectMentionTrigger('@file', 5, [])).toEqual({ query: 'file', triggerPos: 0 });
  expect(detectMentionTrigger('open @file now', 8, [])).toEqual({ query: 'fi', triggerPos: 5 });
  expect(detectMentionTrigger('abc@file', 8, [])).toBeNull();
});
test('does not retrigger tracked labels and prunes deleted labels', () => {
  const tracked = [{ kind: 'file' as const, label: 'file' }];
  expect(detectMentionTrigger('@file', 5, tracked)).toBeNull();
  expect(pruneMentions('deleted', tracked)).toEqual([]);
  expect(pruneMentions('keep @file', tracked)).toEqual(tracked);
});
test('prune returns the same array when nothing is pruned, so a keystroke keeps its identity', () => {
  const tracked = [{ kind: 'file' as const, label: 'file' }];
  expect(pruneMentions('keep @file', tracked)).toBe(tracked);
  const none: typeof tracked = [];
  expect(pruneMentions('any text', none)).toBe(none);
});
