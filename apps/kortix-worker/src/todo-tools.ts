import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

const todosSchema = Type.Array(
  Type.Object({
    content: Type.String({ minLength: 1 }),
    status: Type.Union(
      ['pending', 'in_progress', 'completed', 'cancelled'].map((value) => Type.Literal(value)),
    ),
    priority: Type.Union(['high', 'medium', 'low'].map((value) => Type.Literal(value))),
  }),
);
export interface PiTodo {
  content: string;
  status: string;
  priority: string;
}

export function readTodos(messages: readonly unknown[]): PiTodo[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as
      | { role?: string; toolName?: string; isError?: boolean; details?: { todos?: unknown } }
      | undefined;
    if (message?.role !== 'toolResult' || message.toolName !== 'todowrite' || message.isError)
      continue;
    const todos = message.details?.todos;
    if (Value.Check(todosSchema, todos)) return structuredClone(todos) as PiTodo[];
  }
  return [];
}

export function createTodoTools(options: {
  sessionId: string;
  messages: () => readonly unknown[];
  publish: (event: { type: string; properties: { sessionID: string; todos: PiTodo[] } }) => void;
}): { tools: AgentTool[]; list: () => PiTodo[] } {
  const list = () => readTodos(options.messages());
  const result = (todos: PiTodo[]) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(todos) }],
    details: { todos },
  });
  const write: AgentTool = {
    name: 'todowrite',
    label: 'Update todos',
    description:
      'Create or replace the visible task list for multi-step work. Keep each task status current as work progresses.',
    parameters: Type.Object({ todos: todosSchema }),
    executionMode: 'sequential',
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const todos = (input as { todos?: unknown }).todos;
      if (!Value.Check(todosSchema, todos))
        throw new TypeError('todos must contain valid content, status, and priority');
      const snapshot = structuredClone(todos) as PiTodo[];
      options.publish({
        type: 'todo.updated',
        properties: { sessionID: options.sessionId, todos: snapshot },
      });
      return result(snapshot);
    },
  };
  const read: AgentTool = {
    name: 'todoread',
    label: 'Read todos',
    description: 'Read the current task list and its completion status.',
    parameters: Type.Object({}),
    executionMode: 'sequential',
    async execute() {
      return result(list());
    },
  };
  return { tools: [write, read], list };
}
