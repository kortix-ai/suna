import { describe, expect, test } from 'bun:test';

import {
  applyDraftWrite,
  createKeyedDebouncer,
  draftKey,
  MAX_DRAFT_CHARS,
  MAX_DRAFTS,
  pruneDrafts,
  readDraftText,
  type DraftMap,
} from './composer-draft';

describe('draftKey', () => {
  test('project home and session drafts live under separate families', () => {
    expect(draftKey({ kind: 'project', projectId: 'p1' })).toBe('project:p1');
    expect(draftKey({ kind: 'session', sessionId: 's1' })).toBe('session:s1');
  });
});

describe('applyDraftWrite', () => {
  test('stores typed text with its write time', () => {
    expect(applyDraftWrite({}, 'session:s1', 'hello', 10)).toEqual({ 'session:s1': { text: 'hello', at: 10 } });
  });

  test('keeps the text verbatim, whitespace included', () => {
    expect(applyDraftWrite({}, 'k', '  two\nlines ', 1).k!.text).toBe('  two\nlines ');
  });

  test('blank text removes the draft (a sent or cleared composer)', () => {
    const drafts: DraftMap = { k: { text: 'hi', at: 1 }, other: { text: 'x', at: 1 } };
    expect(applyDraftWrite(drafts, 'k', '   ', 2)).toEqual({ other: { text: 'x', at: 1 } });
  });

  test('text over the ceiling is not kept, and drops an older draft', () => {
    const drafts: DraftMap = { k: { text: 'short', at: 1 } };
    expect(applyDraftWrite(drafts, 'k', 'a'.repeat(MAX_DRAFT_CHARS + 1), 2)).toEqual({});
    expect(applyDraftWrite({}, 'k', 'a'.repeat(MAX_DRAFT_CHARS), 2).k!.text.length).toBe(MAX_DRAFT_CHARS);
  });

  test('a no-op write returns the same object, so storage is not touched', () => {
    const drafts: DraftMap = { k: { text: 'same', at: 1 } };
    expect(applyDraftWrite(drafts, 'k', 'same', 5)).toBe(drafts);
    expect(applyDraftWrite(drafts, 'missing', '', 5)).toBe(drafts);
  });

  test('keeps only the most recently written drafts', () => {
    let drafts: DraftMap = {};
    for (let i = 0; i < MAX_DRAFTS + 3; i++) drafts = applyDraftWrite(drafts, `session:${i}`, `t${i}`, i);
    expect(Object.keys(drafts).length).toBe(MAX_DRAFTS);
    expect(drafts['session:0']).toBeUndefined();
    expect(drafts[`session:${MAX_DRAFTS + 2}`]!.text).toBe(`t${MAX_DRAFTS + 2}`);
  });
});

describe('pruneDrafts', () => {
  test('under the cap returns the same object', () => {
    const drafts: DraftMap = { a: { text: 'a', at: 1 } };
    expect(pruneDrafts(drafts, 2)).toBe(drafts);
  });

  test('over the cap keeps the newest by write time', () => {
    const drafts: DraftMap = { a: { text: 'a', at: 3 }, b: { text: 'b', at: 1 }, c: { text: 'c', at: 2 } };
    expect(Object.keys(pruneDrafts(drafts, 2)).sort()).toEqual(['a', 'c']);
  });
});

describe('readDraftText', () => {
  test('returns the stored text, or empty for a miss or a malformed entry', () => {
    expect(readDraftText({ k: { text: 'hi', at: 1 } }, 'k')).toBe('hi');
    expect(readDraftText({}, 'k')).toBe('');
    expect(readDraftText(undefined, 'k')).toBe('');
    expect(readDraftText({ k: { text: 42, at: 1 } } as unknown as DraftMap, 'k')).toBe('');
  });
});

describe('createKeyedDebouncer', () => {
  function fakeTimers() {
    let next = 0;
    const pending = new Map<number, () => void>();
    return {
      timers: {
        set: (fn: () => void) => {
          const id = ++next;
          pending.set(id, fn);
          return id as unknown as ReturnType<typeof setTimeout>;
        },
        clear: (id: ReturnType<typeof setTimeout>) => {
          pending.delete(id as unknown as number);
        },
      },
      fireAll: () => {
        const fns = [...pending.values()];
        pending.clear();
        for (const fn of fns) fn();
      },
      size: () => pending.size,
    };
  }

  test('only the last scheduled run per key fires', () => {
    const t = fakeTimers();
    const d = createKeyedDebouncer(400, t.timers);
    const runs: string[] = [];
    d.schedule('a', () => runs.push('a1'));
    d.schedule('a', () => runs.push('a2'));
    d.schedule('b', () => runs.push('b1'));
    expect(t.size()).toBe(2);
    t.fireAll();
    expect(runs).toEqual(['a2', 'b1']);
  });

  test('cancel drops a pending run (a successful send)', () => {
    const t = fakeTimers();
    const d = createKeyedDebouncer(400, t.timers);
    const runs: string[] = [];
    d.schedule('a', () => runs.push('a'));
    d.cancel('a');
    t.fireAll();
    expect(runs).toEqual([]);
  });

  test('flush runs every pending write now, once', () => {
    const t = fakeTimers();
    const d = createKeyedDebouncer(400, t.timers);
    const runs: string[] = [];
    d.schedule('a', () => runs.push('a'));
    d.schedule('b', () => runs.push('b'));
    d.flush();
    expect(runs).toEqual(['a', 'b']);
    t.fireAll();
    expect(runs).toEqual(['a', 'b']);
  });

  test('cancelAll drops every pending run (sign-out)', () => {
    const t = fakeTimers();
    const d = createKeyedDebouncer(400, t.timers);
    const runs: string[] = [];
    d.schedule('a', () => runs.push('a'));
    d.schedule('b', () => runs.push('b'));
    d.cancelAll();
    d.flush();
    t.fireAll();
    expect(runs).toEqual([]);
  });
});
