import { describe, expect, test } from 'bun:test';

import { openGenuiFence } from './genui-fence';

describe('openGenuiFence', () => {
  test('text without a generative UI fence has no open block', () => {
    expect(openGenuiFence('Plain answer.')).toBeNull();
    expect(openGenuiFence('```ts\nconst a = 1')).toBeNull();
  });

  test('a closed block is not open', () => {
    expect(openGenuiFence('Intro\n\n```openui\nroot = Stack([])\n```\n\nMore prose')).toBeNull();
  });

  test('an unclosed block at the end is open, with its body so far', () => {
    expect(openGenuiFence('Intro\n\n```openui\nroot = Stack([a])\na = Stat("Rev')).toEqual({
      code: 'root = Stack([a])\na = Stat("Rev',
      closer: '\n```',
    });
  });

  test('the closer repeats the opener marker', () => {
    expect(openGenuiFence('~~~openui\nroot = Stack([])')?.closer).toBe('\n~~~');
    expect(openGenuiFence('````openui-v1\n')?.closer).toBe('\n````');
    expect(openGenuiFence('````openui-v1\n')?.code).toBe('');
    expect(openGenuiFence('```openui')).toEqual({ code: '', closer: '\n```' });
  });

  test('only the last block can be open', () => {
    const text = '```openui\nroot = Stack([])\n```\n\nThen:\n\n```openui\nroot = Table(';
    expect(openGenuiFence(text)?.code).toBe('root = Table(');
  });
});
