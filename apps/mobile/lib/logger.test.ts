import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import {
  DEV_ARG_MAX_CHARS,
  RELEASE_ARG_MAX_CHARS,
  formatArgs,
  log,
  setLoggerUserId,
} from './logger';

describe('formatArgs', () => {
  test('keeps primitives unchanged', () => {
    expect(formatArgs(['msg', 3, true, null, undefined], DEV_ARG_MAX_CHARS)).toEqual([
      'msg',
      3,
      true,
      null,
      undefined,
    ]);
  });

  test('maps an Error to name and message', () => {
    expect(formatArgs([new Error('socket hang up')], DEV_ARG_MAX_CHARS)).toEqual([
      'Error: socket hang up',
    ]);
    expect(formatArgs([new TypeError('x is undefined')], DEV_ARG_MAX_CHARS)).toEqual([
      'TypeError: x is undefined',
    ]);
  });

  test('serialises plain objects', () => {
    expect(formatArgs([{ status: 404 }], DEV_ARG_MAX_CHARS)).toEqual(['{"status":404}']);
  });

  test('truncates a long string argument to the limit', () => {
    const [out] = formatArgs(['a'.repeat(5_000)], RELEASE_ARG_MAX_CHARS) as string[];
    expect(out.length).toBeLessThanOrEqual(RELEASE_ARG_MAX_CHARS + 1);
    expect(out.startsWith('a'.repeat(RELEASE_ARG_MAX_CHARS))).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });

  test('truncates a long serialised object to the limit', () => {
    const big = { body: 'x'.repeat(10_000) };
    const [dev] = formatArgs([big], DEV_ARG_MAX_CHARS) as string[];
    const [release] = formatArgs([big], RELEASE_ARG_MAX_CHARS) as string[];
    expect(dev.length).toBe(DEV_ARG_MAX_CHARS + 1);
    expect(release.length).toBe(RELEASE_ARG_MAX_CHARS + 1);
  });

  test('truncates a long Error message', () => {
    const [out] = formatArgs([new Error('e'.repeat(3_000))], RELEASE_ARG_MAX_CHARS) as string[];
    expect(out.length).toBe(RELEASE_ARG_MAX_CHARS + 1);
  });

  test('survives a cyclic object', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    const [out] = formatArgs([cyclic], DEV_ARG_MAX_CHARS) as string[];
    expect(typeof out).toBe('string');
  });

  test('uses 2 000 characters in development and 500 in release', () => {
    expect(DEV_ARG_MAX_CHARS).toBe(2_000);
    expect(RELEASE_ARG_MAX_CHARS).toBe(500);
  });
});

type Sink = 'log' | 'info' | 'debug' | 'warn' | 'error';

/** Each entry of `log`: the console method it writes to and its prefix. */
const ENTRIES: [keyof typeof log, Sink, string][] = [
  ['log', 'log', '[LEVEL:info]'],
  ['info', 'info', '[LEVEL:info]'],
  ['debug', 'debug', '[LEVEL:debug]'],
  ['warn', 'warn', '[LEVEL:warn]'],
  ['error', 'error', '[LEVEL:error]'],
  ['rc', 'log', '[LEVEL:info] [COMPONENT:RC]'],
  ['rcDebug', 'debug', '[LEVEL:debug] [COMPONENT:RC]'],
  ['rcWarn', 'warn', '[LEVEL:warn] [COMPONENT:RC]'],
  ['rcError', 'error', '[LEVEL:error] [COMPONENT:RC]'],
];

/** Calls `log[name]` with `__DEV__` set and returns every console call it made. */
function capture(name: keyof typeof log, dev: boolean, ...args: unknown[]): [Sink, unknown[]][] {
  Object.assign(globalThis, { __DEV__: dev });
  const calls: [Sink, unknown[]][] = [];
  const sinks: Sink[] = ['log', 'info', 'debug', 'warn', 'error'];
  const spies = sinks.map((sink) =>
    spyOn(console, sink).mockImplementation((...out: unknown[]) => {
      calls.push([sink, out]);
    }),
  );
  try {
    log[name](...args);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return calls;
}

describe('log', () => {
  afterEach(() => setLoggerUserId(null));

  test.each(ENTRIES)('log.%s writes to console.%s with %s in development', (name, sink, level) => {
    setLoggerUserId('user-1234567890abcdef');
    expect(capture(name, true, 'hello', { n: 1 })).toEqual([
      [sink, [`[KTX] [USER:user-1234567] ${level}`, 'hello', '{"n":1}']],
    ]);
  });

  test('an anonymous user is tagged anonymous', () => {
    expect(capture('info', true, 'x')).toEqual([
      ['info', ['[KTX] [USER:anonymous] [LEVEL:info]', 'x']],
    ]);
  });

  test.each(ENTRIES.filter(([, sink]) => sink !== 'error'))(
    'log.%s writes nothing in release',
    (name) => {
      expect(capture(name, false, 'hello')).toEqual([]);
    },
  );

  test.each(ENTRIES.filter(([, sink]) => sink === 'error'))(
    'log.%s still writes in release, capped at the release limit',
    (name, sink, level) => {
      const [[out, [prefix, arg]]] = capture(name, false, 'e'.repeat(DEV_ARG_MAX_CHARS));
      expect(out).toBe(sink);
      expect(prefix).toBe(`[KTX] [USER:anonymous] ${level}`);
      expect(arg).toBe(`${'e'.repeat(RELEASE_ARG_MAX_CHARS)}…`);
    },
  );

  test('development keeps the development limit', () => {
    const [[, [, arg]]] = capture('error', true, 'e'.repeat(DEV_ARG_MAX_CHARS + 10));
    expect(arg).toBe(`${'e'.repeat(DEV_ARG_MAX_CHARS)}…`);
  });

  test('log has exactly the nine entries', () => {
    expect(Object.keys(log).sort()).toEqual(ENTRIES.map(([name]) => name).sort());
  });
});
