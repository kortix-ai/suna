/**
 * Pure logic behind the `todowrite` checklist (web `tool/tools/todo-write-tool.tsx`).
 */

import { parseTodos, type TodoItem } from '@/lib/session/tool-output-parsers';

/** Web source order: the call's input, then its metadata, then the streaming input. */
export function selectTodos({
  input,
  metadata,
  streamingInput,
}: {
  input: Record<string, unknown>;
  metadata: Record<string, unknown>;
  streamingInput: Record<string, unknown>;
}): TodoItem[] {
  const fromInput = parseTodos(input.todos);
  if (fromInput.length) return fromInput;
  const fromMeta = parseTodos(metadata.todos);
  if (fromMeta.length) return fromMeta;
  return parseTodos(streamingInput.todos);
}

export function todoProgress(todos: readonly TodoItem[]) {
  const total = todos.length;
  const done = todos.filter((t) => t.status === 'completed').length;
  const active = todos.find((t) => t.status === 'in_progress');
  const pct = total ? Math.round((done / total) * 100) : 0;

  // Todos carry no id: key on content, with an occurrence counter for repeats.
  const seen = new Map<string, number>();
  const keyed = todos.map((todo) => {
    const n = seen.get(todo.content) ?? 0;
    seen.set(todo.content, n + 1);
    return { todo, key: n === 0 ? todo.content : `${todo.content}#${n}` };
  });

  return {
    total,
    done,
    pct,
    keyed,
    subtitle: active ? active.content : total ? `${done} of ${total} done` : undefined,
    badge: total ? `${done}/${total}` : undefined,
  };
}
