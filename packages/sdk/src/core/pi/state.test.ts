import { expect, test } from 'bun:test';
import { createPiAgentState, PiStateConflictError, type PiStateSnapshot } from './state';

function fixture() {
  const values = new Map<string, PiStateSnapshot>();
  let conflicts = 0;
  const state = createPiAgentState({
    read: async (name) => structuredClone(values.get(name) ?? null),
    write: async (name, next) => {
      if (conflicts-- > 0 || next.revision !== (values.get(name)?.revision ?? 0) + 1)
        throw new PiStateConflictError();
      values.set(name, structuredClone(next));
    },
  });
  return {
    state,
    values,
    conflict: (count: number) => {
      conflicts = count;
    },
  };
}

test('namespaced state initializes once, updates by revision and returns detached JSON', async () => {
  const f = fixture();
  const options = { schemaVersion: 1, initialValue: { count: 0 } };
  const counter = await f.state.open('counter', options);
  options.initialValue.count = 90;
  expect(await counter.update((value) => ({ count: value.count + 1 }))).toEqual({
    revision: 2,
    schemaVersion: 1,
    value: { count: 1 },
  });
  const read = await counter.read();
  read.value.count = 999;
  const replacement = await f.state.open('counter', {
    schemaVersion: 1,
    initialValue: { count: 0 },
  });
  expect((await replacement.read()).value).toEqual({ count: 1 });
  expect(f.values.size).toBe(1);
});

test('atomic migrations preserve previous state on failure and reject older code afterward', async () => {
  const f = fixture();
  const old = await f.state.open('counter', { schemaVersion: 1, initialValue: 7 });
  await expect(
    f.state.open('counter', {
      schemaVersion: 2,
      initialValue: { count: 0 },
      migrate: () => {
        throw new Error('bad migration');
      },
    }),
  ).rejects.toThrow('bad migration');
  expect((await old.read()).value).toBe(7);
  await expect(f.state.open('counter', { schemaVersion: 2, initialValue: 0 })).rejects.toThrow(
    /migration/,
  );
  const upgraded = await f.state.open('counter', {
    schemaVersion: 2,
    initialValue: { count: 0 },
    migrate: (previous) => ({ count: Number(previous.value) }),
  });
  expect(await upgraded.read()).toEqual({ revision: 2, schemaVersion: 2, value: { count: 7 } });
  await expect(old.read()).rejects.toThrow(/newer/);
  await expect(old.update(() => 8)).rejects.toThrow(/newer/);
});

test('concurrent updates retry against committed values without losing increments', async () => {
  const f = fixture();
  const counter = await f.state.open('counter', { schemaVersion: 1, initialValue: 0 });
  const second = await f.state.open('counter', { schemaVersion: 1, initialValue: 0 });
  await Promise.all([counter.update((n) => n + 1), second.update((n) => n + 1)]);
  expect((await counter.read()).value).toBe(2);
  f.conflict(20);
  await expect(counter.update((n) => n + 1)).rejects.toBeInstanceOf(PiStateConflictError);
  expect((await counter.read()).value).toBe(2);
});

test('invalid configuration and non-JSON state fail before any write', async () => {
  const f = fixture();
  const cycle: any = {};
  cycle.self = cycle;
  for (const value of [
    undefined,
    NaN,
    Infinity,
    1n,
    () => {},
    new Date(),
    new Map(),
    cycle,
    { a: undefined },
    [undefined],
    'x'.repeat(65537),
  ]) {
    await expect(
      f.state.open('invalid', { schemaVersion: 1, initialValue: value as any }),
    ).rejects.toThrow();
  }
  for (const name of ['', '../other', 'a'.repeat(65), '__proto__']) {
    await expect(f.state.open(name, { schemaVersion: 1, initialValue: null })).rejects.toThrow();
  }
  for (const schemaVersion of [0, -1, 1.5, NaN]) {
    await expect(f.state.open('invalid', { schemaVersion, initialValue: null })).rejects.toThrow();
  }
  await expect(
    f.state.open('invalid', { schemaVersion: 1, initialValue: null, hidden: true } as any),
  ).rejects.toThrow(/unsupported/);
  expect(f.values.size).toBe(0);
});

test('update failure and mutation of callback input never alter saved state', async () => {
  const f = fixture();
  const counter = await f.state.open('counter', { schemaVersion: 1, initialValue: { count: 1 } });
  await expect(
    counter.update((value) => {
      value.count = 9;
      throw new Error('failed update');
    }),
  ).rejects.toThrow('failed update');
  await expect(counter.update(() => ({ count: NaN }))).rejects.toThrow();
  expect((await counter.read()).value).toEqual({ count: 1 });
});
