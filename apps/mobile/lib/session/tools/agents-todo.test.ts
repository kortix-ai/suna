import { describe, expect, test } from 'bun:test';

import { selectTodos, todoProgress } from './agents-todo';

describe('selectTodos (web todo-write-tool.tsx source order)', () => {
  const a = [{ content: 'from input', status: 'pending' }];
  const b = [{ content: 'from metadata', status: 'completed' }];
  const c = [{ content: 'streaming', status: 'in_progress' }];

  test('input, then metadata, then the streaming input', () => {
    expect(selectTodos({ input: { todos: a }, metadata: { todos: b }, streamingInput: { todos: c } })[0].content).toBe('from input');
    expect(selectTodos({ input: {}, metadata: { todos: b }, streamingInput: { todos: c } })[0].content).toBe('from metadata');
    expect(selectTodos({ input: {}, metadata: {}, streamingInput: { todos: c } })[0].content).toBe('streaming');
    expect(selectTodos({ input: {}, metadata: {}, streamingInput: {} })).toEqual([]);
  });
});

describe('todoProgress', () => {
  test('subtitle is the active item, else "N of M done"', () => {
    const todos = [
      { content: 'One', status: 'completed' as const },
      { content: 'Two', status: 'in_progress' as const },
      { content: 'Three', status: 'pending' as const },
      { content: 'Four', status: 'completed' as const },
    ];
    const p = todoProgress(todos);
    expect(p.total).toBe(4);
    expect(p.done).toBe(2);
    expect(p.pct).toBe(50);
    expect(p.subtitle).toBe('Two');
    expect(p.badge).toBe('2/4');

    const idle = todoProgress([todos[0], todos[2]]);
    expect(idle.subtitle).toBe('1 of 2 done');

    const empty = todoProgress([]);
    expect(empty.subtitle).toBeUndefined();
    expect(empty.pct).toBe(0);
    expect(empty.badge).toBeUndefined();
  });

  test('repeated lines get an occurrence counter so keys stay unique', () => {
    const p = todoProgress([
      { content: 'Same', status: 'pending' },
      { content: 'Same', status: 'pending' },
      { content: 'Other', status: 'pending' },
    ]);
    expect(p.keyed.map((k) => k.key)).toEqual(['Same', 'Same#1', 'Other']);
  });
});
