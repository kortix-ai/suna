import { afterEach, describe, expect, test } from 'bun:test';

import { installMatchAllGroupsFix, matchAllDropsGroups, matchAllWithGroups } from './match-all-groups';

const native = String.prototype.matchAll;

/** Reproduce the Hermes defect on V8/JSC: matches come back without `groups`. */
function simulateHermesDefect() {
  Object.defineProperty(String.prototype, 'matchAll', {
    configurable: true,
    writable: true,
    value: function (this: string, re: RegExp) {
      return (function* (it: IterableIterator<RegExpExecArray>) {
        for (const m of it) {
          Object.defineProperty(m, 'groups', { value: undefined });
          yield m;
        }
      })(native.call(this, re));
    },
  });
}

afterEach(() => {
  Object.defineProperty(String.prototype, 'matchAll', { configurable: true, writable: true, value: native });
});

describe('matchAllWithGroups', () => {
  test('returns the same matches as the native implementation, groups included', () => {
    const cases: [string, RegExp][] = [
      ['a1b22c333', /(?<d>\d+)/g],
      ['[^x]\\y', /\\(?<esc>.)|(?<skip>\[\^?|.)/gsu],
      ['', /(?<e>)/g],
      ['😀a😀', /(?:)/gu],
      ['abcabc', /(?<l>b)/dg],
    ];
    for (const [input, re] of cases) {
      const ours = [...matchAllWithGroups.call(input, re)].map((m) => [m[0], m.index, { ...m.groups }]);
      const theirs = [...native.call(input, re)].map((m) => [m[0], m.index, { ...m.groups }]);
      expect(ours).toEqual(theirs);
    }
  });

  test('leaves the argument regex lastIndex untouched and honours a string pattern', () => {
    const re = /a/g;
    re.lastIndex = 1;
    expect([...matchAllWithGroups.call('aaa', re)].map((m) => m.index)).toEqual([1, 2]);
    expect(re.lastIndex).toBe(1);
    expect([...matchAllWithGroups.call('a.a', '\\.')].map((m) => m.index)).toEqual([1]);
  });

  test('rejects a non-global regex like the spec', () => {
    expect(() => matchAllWithGroups.call('a', /a/)).toThrow(TypeError);
  });
});

describe('installMatchAllGroupsFix', () => {
  test('does nothing on an engine without the defect', () => {
    expect(matchAllDropsGroups()).toBe(false);
    expect(installMatchAllGroupsFix()).toBe(false);
    expect(String.prototype.matchAll).toBe(native);
  });

  test('replaces matchAll when groups are dropped', () => {
    simulateHermesDefect();
    expect(matchAllDropsGroups()).toBe(true);
    expect(installMatchAllGroupsFix()).toBe(true);
    expect(matchAllDropsGroups()).toBe(false);
    expect([...'x1'.matchAll(/(?<n>\d)/g)][0].groups).toEqual({ n: '1' });
  });
});
