import { describe, expect, test } from 'bun:test';

import { genuiVersionFromClassName, genuiVersionOf, splitGenui } from './fence';

describe('fence', () => {
  test('version tags', () => {
    expect(genuiVersionOf('openui')).toBe(1);
    expect(genuiVersionOf('OpenUI-Lang')).toBe(1);
    expect(genuiVersionOf('openui-v2')).toBe(2);
    expect(genuiVersionOf('python')).toBeNull();
    expect(genuiVersionFromClassName('language-openui-lang')).toBe(1);
    expect(genuiVersionFromClassName('language-openui-v2')).toBe(2);
    expect(genuiVersionFromClassName('language-ts')).toBeNull();
  });

  test('splits prose and blocks in order, keeps other fences as markdown', () => {
    const text = 'Intro\n\n```openui\nroot = Stack([x])\n```\n\n```ts\nconst a = 1\n```\nEnd';
    expect(splitGenui(text)).toEqual([
      { kind: 'markdown', text: 'Intro\n' },
      { kind: 'genui', code: 'root = Stack([x])', version: 1, closed: true },
      { kind: 'markdown', text: '\n```ts\nconst a = 1\n```\nEnd' },
    ]);
  });

  test('an openui tag inside another fence stays markdown', () => {
    const text = '````md\n```openui\nroot = Stack([])\n```\n````';
    expect(splitGenui(text)).toEqual([{ kind: 'markdown', text }]);
  });

  test('an unclosed block is still streaming', () => {
    expect(splitGenui('Hi\n```openui\nroot = Sta')).toEqual([
      { kind: 'markdown', text: 'Hi' },
      { kind: 'genui', code: 'root = Sta', version: 1, closed: false },
    ]);
  });
});
