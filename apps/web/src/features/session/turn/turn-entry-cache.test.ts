import { describe, expect, test } from 'bun:test';

import { reconcileTurnEntries, type TurnEntryDeps } from './turn-entry-cache';

/** Distinct object identities standing in for turns. */
const turnObj = (id: string) => ({ id });

/** One shared bundle reused across passes, so it compares equal by identity. */
const SHARED = { sessionId: 's1' };

function deps(over: Partial<TurnEntryDeps> & { turn: unknown }): TurnEntryDeps {
  return {
    isLastUserTurn: false,
    isPlanAnchor: false,
    isCompaction: false,
    isFirstTurn: false,
    permissions: 'P',
    questions: 'Q',
    shared: SHARED,
    sessionStatus: 'idle',
    isBusy: false,
    ...over,
  };
}

/** Runs one reconcile pass, counting how many entries were actually computed. */
function pass(
  turnList: { id: string; obj: unknown; deps: TurnEntryDeps }[],
  previous = new Map(),
) {
  let created = 0;
  const result = reconcileTurnEntries(
    turnList,
    (t) => t.id,
    (t) => t.deps,
    (d) => {
      created++;
      return { computedFor: d.turn };
    },
    previous,
  );
  return { ...result, created };
}

describe('reconcileTurnEntries', () => {
  const a = turnObj('a');
  const b = turnObj('b');
  const c = turnObj('c');
  const base = [
    { id: 'a', obj: a, deps: deps({ turn: a }) },
    { id: 'b', obj: b, deps: deps({ turn: b }) },
    { id: 'c', obj: c, deps: deps({ turn: c, isLastUserTurn: true }) },
  ];

  test('computes every entry on the first pass', () => {
    expect(pass(base).created).toBe(3);
  });

  // THE BUG THIS EXISTS FOR. A streamed token gives `turns` a new array
  // identity while every turn OBJECT is unchanged. Rebuilding the map wholesale
  // recomputed every turn's row inputs — a scan of every message in the thread,
  // on every token.
  test('recomputes nothing when no turn changed', () => {
    const first = pass(base);
    const second = pass(base, first.cache);

    expect(second.created).toBe(0);
  });

  test('reuses the previous entry OBJECT, so downstream memos still hit', () => {
    const first = pass(base);
    const second = pass(base, first.cache);

    expect(second.entries.get('a')).toBe(first.entries.get('a'));
    expect(second.entries.get('c')).toBe(first.entries.get('c'));
  });

  test('recomputes only the turn whose object identity changed', () => {
    const first = pass(base);
    const c2 = turnObj('c');
    const next = [
      base[0],
      base[1],
      { id: 'c', obj: c2, deps: deps({ turn: c2, isLastUserTurn: true }) },
    ];
    const second = pass(next, first.cache);

    expect(second.created).toBe(1);
    expect(second.entries.get('a')).toBe(first.entries.get('a'));
    expect(second.entries.get('c')).not.toBe(first.entries.get('c'));
  });

  // `working` is `getWorkingState(sessionStatus, isLastUserTurn) || (isLastUserTurn && isBusy)`,
  // and getWorkingState returns false immediately when isLast is false
  // (packages/sdk/src/core/turns/state.ts:78). So a non-last turn CANNOT depend
  // on either signal — and those two change constantly while streaming.
  test('a streaming status change recomputes only the last user turn', () => {
    const first = pass(base);
    const next = base.map((t) =>
      t.id === 'c'
        ? { ...t, deps: deps({ turn: c, isLastUserTurn: true, sessionStatus: 'busy', isBusy: true }) }
        : { ...t, deps: deps({ turn: t.obj, sessionStatus: 'busy', isBusy: true }) },
    );
    const second = pass(next, first.cache);

    expect(second.created).toBe(1);
    expect(second.entries.get('a')).toBe(first.entries.get('a'));
    expect(second.entries.get('b')).toBe(first.entries.get('b'));
  });

  test('a permission arriving recomputes every turn, because any turn can own it', () => {
    const first = pass(base);
    const next = base.map((t) => ({ ...t, deps: { ...t.deps, permissions: 'P2' } }));

    expect(pass(next, first.cache).created).toBe(3);
  });

  test('a prepended turn computes only itself', () => {
    const first = pass(base);
    const z = turnObj('z');
    const next = [{ id: 'z', obj: z, deps: deps({ turn: z }) }, ...base];

    expect(pass(next, first.cache).created).toBe(1);
  });

  // A shared prop changing (the rewind gate flipping, a provider list loading)
  // affects how every turn renders, so every entry must be rebuilt.
  test('a change to the shared bundle rebuilds every entry', () => {
    const first = pass(base);
    const next = base.map((t) => ({ ...t, deps: { ...t.deps, shared: { sessionId: 's1' } } }));

    expect(pass(next, first.cache).created).toBe(3);
  });

  // A rewind drops turns. Without eviction the cache grows for the life of the
  // session and pins every dropped turn's derived arrays in memory.
  test('drops turns that are gone, so the cache cannot grow without bound', () => {
    const first = pass(base);
    const second = pass([base[0]], first.cache);

    expect(second.cache.size).toBe(1);
    expect(second.entries.has('b')).toBe(false);
  });

  test('preserves turn order in the returned entries', () => {
    expect([...pass(base).entries.keys()]).toEqual(['a', 'b', 'c']);
  });

  // The whole point, stated as complexity rather than as a single case.
  //
  // A long thread streaming a reply: only the last turn's object changes per
  // token, and `sessionStatus`/`isBusy` flap constantly. Work must scale with
  // what CHANGED (1 per token), not with thread length (100 per token).
  test('streaming a long thread costs one recompute per token, not one per turn', () => {
    const TURNS = 100;
    const TOKENS = 50;

    let objects = Array.from({ length: TURNS }, (_, i) => turnObj(`t${i}`));
    const build = (objs: { id: string }[], status: string, busy: boolean) =>
      objs.map((obj, i) => ({
        id: obj.id,
        obj,
        deps: deps({
          turn: obj,
          isLastUserTurn: i === objs.length - 1,
          isFirstTurn: i === 0,
          sessionStatus: status,
          isBusy: busy,
        }),
      }));

    let cache = new Map();
    let created = 0;
    ({ cache, created } = pass(build(objects, 'idle', false)));
    expect(created).toBe(TURNS); // first paint computes everything

    let streamed = 0;
    for (let token = 0; token < TOKENS; token++) {
      // A token rewrites ONLY the last turn's object; every other turn keeps
      // its identity, exactly as groupMessagesIntoTurns guarantees.
      objects = [...objects.slice(0, -1), turnObj(`t${TURNS - 1}`)];
      const r = pass(build(objects, token % 2 ? 'busy' : 'working', true), cache);
      cache = r.cache;
      streamed += r.created;
    }

    expect(streamed).toBe(TOKENS);
    // The bug this replaced would have been TOKENS * TURNS.
    expect(streamed).toBeLessThan((TOKENS * TURNS) / 10);
  });
});
