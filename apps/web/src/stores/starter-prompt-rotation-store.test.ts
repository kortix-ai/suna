import { beforeEach, describe, expect, test } from 'bun:test';

import { isRotationUsable, nextLocalMidnight, RECENT_MEMORY } from '@/lib/starter-prompt-rotation';
import { ROTATING_STARTER_PROMPT_IDS, WORKFORCE_STARTER_PROMPT_IDS } from '@/lib/starter-prompts';
import { ROTATION_SIZE, useStarterRotationStore } from './starter-prompt-rotation-store';

const POOL_IDS = new Set(ROTATING_STARTER_PROMPT_IDS);

/** Back to the pristine, un-rehydrated defaults — the shape a first visit has. */
beforeEach(() => {
  useStarterRotationStore.setState({ ids: [], expiresAt: 0, recent: [] });
});

describe('refresh picks a usable set', () => {
  test('from empty defaults, it picks and dates the set', () => {
    const now = Date.parse('2026-09-01T09:00:00Z');
    useStarterRotationStore.getState().refresh(now);

    const { ids, expiresAt } = useStarterRotationStore.getState();
    expect(ids).toHaveLength(ROTATION_SIZE);
    expect(new Set(ids).size).toBe(ROTATION_SIZE);
    for (const id of ids) expect(ROTATING_STARTER_PROMPT_IDS).toContain(id);
    expect(expiresAt).toBe(nextLocalMidnight(now));
  });

  test('what it picks passes the same check that judges a persisted set', () => {
    const now = Date.now();
    useStarterRotationStore.getState().refresh(now);
    expect(isRotationUsable(useStarterRotationStore.getState(), now, POOL_IDS, ROTATION_SIZE)).toBe(
      true,
    );
  });
});

describe('refresh leaves a still-usable set alone', () => {
  // The point of persisting: a refresh mid-day must not reshuffle the band.
  test('a second call on the same day changes nothing', () => {
    const now = Date.now();
    useStarterRotationStore.getState().refresh(now);
    const first = useStarterRotationStore.getState().ids;

    useStarterRotationStore.getState().refresh(now);
    expect(useStarterRotationStore.getState().ids).toBe(first);
  });

  test('it re-picks once the expiry has passed', () => {
    const now = Date.now();
    useStarterRotationStore.getState().refresh(now);
    const { ids: first, expiresAt } = useStarterRotationStore.getState();

    useStarterRotationStore.getState().refresh(expiresAt + 1);
    expect(useStarterRotationStore.getState().expiresAt).toBeGreaterThan(expiresAt);
    expect(useStarterRotationStore.getState().ids).not.toBe(first);
  });
});

describe('refresh repairs a corrupt rehydration', () => {
  // localStorage is shared with every tab and extension on the origin, so
  // `persist` can hand back anything. Each of these must end in a fresh pick,
  // never in a short or duplicated band.
  const now = Date.now();

  test('an id that has left the pool', () => {
    useStarterRotationStore.setState({
      ids: [...ROTATING_STARTER_PROMPT_IDS.slice(0, ROTATION_SIZE - 1), 'deleted-prompt'],
      expiresAt: now + 60_000,
      recent: [],
    });

    useStarterRotationStore.getState().refresh(now);

    const { ids } = useStarterRotationStore.getState();
    expect(ids).not.toContain('deleted-prompt');
    expect(ids).toHaveLength(ROTATION_SIZE);
  });

  test('the wrong number of ids', () => {
    useStarterRotationStore.setState({
      ids: ['landing-page'],
      expiresAt: now + 60_000,
      recent: [],
    });
    useStarterRotationStore.getState().refresh(now);
    expect(useStarterRotationStore.getState().ids).toHaveLength(ROTATION_SIZE);
  });

  test('a duplicated id', () => {
    const dupe = ROTATING_STARTER_PROMPT_IDS[0];
    useStarterRotationStore.setState({
      ids: Array.from({ length: ROTATION_SIZE }, () => dupe),
      expiresAt: now + 60_000,
      recent: [],
    });

    useStarterRotationStore.getState().refresh(now);
    expect(new Set(useStarterRotationStore.getState().ids).size).toBe(ROTATION_SIZE);
  });
});

describe('a new day means new prompts, not just a new draw', () => {
  // The question this feature has to answer: after 24 hours, is it actually
  // showing something different? Uniform random said no 22% of the time.
  test('ten consecutive days never repeat a prompt', () => {
    let now = Date.parse('2026-09-01T09:00:00Z');
    let previous: string[] = [];

    for (let day = 0; day < 10; day++) {
      useStarterRotationStore.getState().refresh(now);
      const { ids, expiresAt } = useStarterRotationStore.getState();

      expect(ids).toHaveLength(ROTATION_SIZE);
      for (const id of ids) expect(previous).not.toContain(id);

      previous = ids;
      now = expiresAt + 1;
    }
  });

  test('the recent window accumulates and then stops growing', () => {
    let now = Date.parse('2026-09-01T09:00:00Z');

    for (let day = 0; day < 3; day++) {
      useStarterRotationStore.getState().refresh(now);
      now = useStarterRotationStore.getState().expiresAt + 1;
    }
    expect(useStarterRotationStore.getState().recent).toHaveLength(3 * ROTATION_SIZE);

    for (let day = 0; day < 30; day++) {
      useStarterRotationStore.getState().refresh(now);
      now = useStarterRotationStore.getState().expiresAt + 1;
    }
    expect(useStarterRotationStore.getState().recent).toHaveLength(RECENT_MEMORY);
  });

  // A corrupt window must not silently disable the memory.
  test('a rehydrated window full of junk is sanitised, not trusted', () => {
    const now = Date.now();
    useStarterRotationStore.setState({
      ids: [],
      expiresAt: 0,
      recent: ['not-a-real-prompt', 'landing-page'] as string[],
    });

    useStarterRotationStore.getState().refresh(now);

    const { recent, ids } = useStarterRotationStore.getState();
    expect(recent).not.toContain('not-a-real-prompt');
    expect(recent).toContain('landing-page');
    expect(ids).not.toContain('landing-page');
  });
});

describe('one row is always a workforce prompt', () => {
  const WORKFORCE = new Set(WORKFORCE_STARTER_PROMPT_IDS);

  /*
   * The reservation exists because growing the pool broke the thing the
   * workforce group was added for. At 18 in 185 a uniform pick shows NONE of
   * them on 60% of days — measured, not estimated — so the band would read as
   * generic knowledge work five days out of eight.
   */
  test('every day for a year includes at least one', () => {
    let now = Date.parse('2026-09-01T09:00:00Z');

    for (let day = 0; day < 365; day++) {
      useStarterRotationStore.getState().refresh(now);
      const { ids, expiresAt } = useStarterRotationStore.getState();

      expect(ids.some((id) => WORKFORCE.has(id))).toBe(true);
      now = expiresAt + 1;
    }
  });

  // Exactly one, not more: the other four slots stay general, or the
  // reservation would quietly become a takeover.
  test('exactly one, so the other four stay general', () => {
    let now = Date.parse('2026-09-01T09:00:00Z');

    for (let day = 0; day < 60; day++) {
      useStarterRotationStore.getState().refresh(now);
      const { ids, expiresAt } = useStarterRotationStore.getState();

      expect(ids.filter((id) => WORKFORCE.has(id))).toHaveLength(1);
      expect(ids).toHaveLength(ROTATION_SIZE);
      now = expiresAt + 1;
    }
  });

  // If the reserved row always landed in the same slot, the band would have a
  // fixed shape and the reservation would read as a header rather than a row.
  test('it does not always sit in the same position', () => {
    const positions = new Set<number>();
    let now = Date.parse('2026-09-01T09:00:00Z');

    for (let day = 0; day < 60; day++) {
      useStarterRotationStore.getState().refresh(now);
      const { ids, expiresAt } = useStarterRotationStore.getState();
      positions.add(ids.findIndex((id) => WORKFORCE.has(id)));
      now = expiresAt + 1;
    }

    expect(positions.size).toBeGreaterThan(1);
  });

  // The reservation must not weaken the no-repeat guarantee it sits inside.
  test('and it still never repeats a prompt across ten days', () => {
    let now = Date.parse('2026-09-01T09:00:00Z');
    const history: string[][] = [];

    for (let day = 0; day < 60; day++) {
      useStarterRotationStore.getState().refresh(now);
      const { ids, expiresAt } = useStarterRotationStore.getState();

      const lastTen = history.slice(-10).flat();
      for (const id of ids) expect(lastTen).not.toContain(id);

      history.push([...ids]);
      now = expiresAt + 1;
    }
  });
});

describe('the shuffle control', () => {
  const WORKFORCE = new Set(WORKFORCE_STARTER_PROMPT_IDS);

  test('re-picks immediately, without waiting for the expiry', () => {
    const now = Date.now();
    useStarterRotationStore.getState().refresh(now);
    const before = useStarterRotationStore.getState().ids;

    useStarterRotationStore.getState().reshuffle();

    expect(useStarterRotationStore.getState().ids).not.toEqual(before);
  });

  // Pressing it is how a person says "not these". Handing back something from
  // two presses ago is the one thing it must never do.
  test('presses in a row never repeat a prompt, and keep the reserved row', () => {
    useStarterRotationStore.getState().refresh(Date.now());
    const seen: string[][] = [useStarterRotationStore.getState().ids];

    for (let press = 0; press < 8; press++) {
      useStarterRotationStore.getState().reshuffle();
      const { ids } = useStarterRotationStore.getState();

      for (const id of ids) expect(seen.flat()).not.toContain(id);
      expect(ids.filter((id) => WORKFORCE.has(id))).toHaveLength(1);
      expect(ids).toHaveLength(ROTATION_SIZE);

      seen.push([...ids]);
    }
  });

  // Shuffling is "show me different ones", not "restart my day". Pressing it at
  // noon must still leave tonight's midnight roll in place.
  test('does not push the daily roll past tonight', () => {
    const beforeMidnight = nextLocalMidnight(Date.now());

    useStarterRotationStore.getState().reshuffle();
    const { expiresAt } = useStarterRotationStore.getState();

    expect(expiresAt).toBe(beforeMidnight);
    expect(expiresAt).toBeGreaterThan(Date.now());
  });
});

describe('the store is governed like every other persisted store', () => {
  // `persisted-store-coverage.test.ts` proves the key is swept and the store
  // registers a sign-out reset. This asserts the OTHER half of that contract:
  // resetting really does return the pristine shape, so a signed-out browser
  // does not hand the next person the previous person's band.
  test('resetting to the initial state empties the rotation', () => {
    useStarterRotationStore.getState().refresh(Date.now());
    expect(useStarterRotationStore.getState().ids).toHaveLength(ROTATION_SIZE);

    const pristine = useStarterRotationStore.getInitialState();
    expect(pristine.ids).toEqual([]);
    expect(pristine.expiresAt).toBe(0);
  });
});
