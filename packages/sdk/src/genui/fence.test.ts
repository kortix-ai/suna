import { describe, expect, test } from 'bun:test';

import { genuiVersionFromClassName, genuiVersionOf, separateGenuiClosers, splitGenui } from './fence';

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

  test('a closing fence indented 4+ spaces does not close the block', () => {
    const text = '```openui\nroot = Stack([b])\n    ```\nb = Badge("x")\n```';
    expect(splitGenui(text)).toEqual([
      { kind: 'genui', code: 'root = Stack([b])\n    ```\nb = Badge("x")', version: 1, closed: true },
    ]);
  });

  test('an unclosed block is still streaming', () => {
    expect(splitGenui('Hi\n```openui\nroot = Sta')).toEqual([
      { kind: 'markdown', text: 'Hi' },
      { kind: 'genui', code: 'root = Sta', version: 1, closed: false },
    ]);
  });

  test('long fence-like lines split in linear time', () => {
    const started = performance.now();
    const open = `\`\`\`${'a'.repeat(40_000)}\``;
    expect(splitGenui(open)).toEqual([{ kind: 'markdown', text: open }]);
    const close = `${'`'.repeat(40_000)}x`;
    expect(splitGenui(`\`\`\`openui\n${close}`)).toEqual([{ kind: 'genui', code: close, version: 1, closed: false }]);
    expect(performance.now() - started).toBeLessThan(200);
  });

  test('a backtick in the info string means no fence, for both markers', () => {
    const backtick = '```openui `x`\nroot = Stack([])\n```';
    expect(splitGenui(backtick)).toEqual([{ kind: 'markdown', text: backtick }]);
    expect(splitGenui('~~~openui `x`')).toEqual([{ kind: 'markdown', text: '~~~openui `x`' }]);
    expect(splitGenui('~~~ openui extra\nroot = Stack([])\n~~~')).toEqual([
      { kind: 'genui', code: 'root = Stack([])', version: 1, closed: true },
    ]);
  });

  describe('separateGenuiClosers', () => {
    test('a closer glued after `)`, `]`, or `"` moves to its own line', () => {
      expect(separateGenuiClosers('```openui\nroot = Stack([b])\nb = Badge("x")```\nAfter')).toBe(
        '```openui\nroot = Stack([b])\nb = Badge("x")\n```\nAfter',
      );
      expect(separateGenuiClosers('~~~~openui\nt = Table(["k"], [["1"]])~~~~  ')).toBe('~~~~openui\nt = Table(["k"], [["1"]])\n~~~~');
      expect(separateGenuiClosers('```openui\nx = "a"```')).toBe('```openui\nx = "a"\n```');
      const glued = 'Hi\n```openui\nroot = Stack([b])\nb = Badge("x")```\nAfter';
      expect(splitGenui(separateGenuiClosers(glued))).toEqual([
        { kind: 'markdown', text: 'Hi' },
        { kind: 'genui', code: 'root = Stack([b])\nb = Badge("x")', version: 1, closed: true },
        { kind: 'markdown', text: 'After' },
      ]);
    });

    test('a string literal that ends with backticks mid-line is not split', () => {
      const text = '```openui\nc = Callout("info", "run ```", "Tip")\nd = Callout("info", "```")x\n```';
      expect(separateGenuiClosers(text)).toBe(text);
    });

    test('a shorter run or the other marker is not a closer', () => {
      const text = '````openui\nb = Badge("x")```\nc = Badge("y")~~~~\n````';
      expect(separateGenuiClosers(text)).toBe(text);
    });

    test('the closer keeps the container prefix: list indent and blockquote', () => {
      expect(separateGenuiClosers('- a\n\n  ```openui\n  b = Badge("x")```\n')).toBe('- a\n\n  ```openui\n  b = Badge("x")\n  ```\n');
      expect(separateGenuiClosers('1. ```openui\n   b = Badge("x")```')).toBe('1. ```openui\n   b = Badge("x")\n   ```');
      expect(separateGenuiClosers('> ```openui\n> b = Badge("x")```')).toBe('> ```openui\n> b = Badge("x")\n> ```');
    });

    test('nothing outside an openui fence changes', () => {
      const text = 'f(x)```\n```ts\nconst a = f("x")```\n```\n````md\n```openui\nb = Badge("x")```\n````\nafter("x")```';
      expect(separateGenuiClosers(text)).toBe(text);
      const done = '```openui\nb = Badge("x")\n```\nlater("y")```';
      expect(separateGenuiClosers(done)).toBe(done);
    });

    test('text without a glued closer is the same string; long lines stay linear', () => {
      const text = '```openui\nroot = Stack([b])\n```';
      expect(separateGenuiClosers(text)).toBe(text);
      const started = performance.now();
      separateGenuiClosers(`\`\`\`openui\n${')`'.repeat(40_000)}\n${'`'.repeat(40_000)}x`);
      expect(performance.now() - started).toBeLessThan(200);
    });
  });
});
