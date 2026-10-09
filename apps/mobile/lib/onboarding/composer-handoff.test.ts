import { describe, expect, test } from 'bun:test';
import { markComposerFocus, subscribeComposerFocus, takeComposerFocus } from './composer-handoff';

describe('composer focus hand-off', () => {
  test('a request is taken once', () => {
    markComposerFocus('p1');
    expect(takeComposerFocus('p1')).toBe(true);
    expect(takeComposerFocus('p1')).toBe(false);
  });

  test('a request for one project is not taken by another', () => {
    markComposerFocus('p1');
    expect(takeComposerFocus('p2')).toBe(false);
    expect(takeComposerFocus('p1')).toBe(true);
  });

  test('a mounted home is told about a request and can take it', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeComposerFocus((projectId) => {
      seen.push(projectId);
      expect(takeComposerFocus(projectId)).toBe(true);
    });
    markComposerFocus('p1');
    expect(seen).toEqual(['p1']);
    expect(takeComposerFocus('p1')).toBe(false);
    unsubscribe();
  });

  test('an unsubscribed home is not told; the request waits for the next mount', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeComposerFocus((projectId) => seen.push(projectId));
    unsubscribe();
    markComposerFocus('p1');
    expect(seen).toEqual([]);
    expect(takeComposerFocus('p1')).toBe(true);
  });
});
