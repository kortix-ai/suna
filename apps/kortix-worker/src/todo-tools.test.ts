import { expect, test } from 'bun:test';
import { createTodoTools, readTodos } from './todo-tools.ts';

test('todo updates publish the UI event and restore from the durable tool result', async () => {
  const messages: any[] = [];
  const events: any[] = [];
  const runtime = createTodoTools({
    sessionId: 'ses_1',
    messages: () => messages,
    publish: (event) => events.push(event),
  });
  const todos = [{ content: 'Check streaming', status: 'in_progress', priority: 'high' }];
  const result = await runtime.tools[0]!.execute('call_1', { todos });
  expect(events).toEqual([{ type: 'todo.updated', properties: { sessionID: 'ses_1', todos } }]);
  messages.push({ role: 'toolResult', toolName: 'todowrite', ...result });
  expect(runtime.list()).toEqual(todos);
  expect(readTodos(structuredClone(messages))).toEqual(todos);
  const read = await runtime.tools[1]!.execute('call_2', {});
  expect(read.details).toEqual({ todos });
  messages.splice(0);
  expect(runtime.list()).toEqual([]);
});

test('invalid, failed, and unrelated tool results do not become a todo list', () => {
  expect(readTodos([{ role: 'toolResult', toolName: 'bash', details: { todos: [] } }])).toEqual([]);
  expect(
    readTodos([
      {
        role: 'toolResult',
        toolName: 'todowrite',
        isError: true,
        details: { todos: [{ content: 'wrong', status: 'pending', priority: 'high' }] },
      },
    ]),
  ).toEqual([]);
  expect(
    readTodos([
      {
        role: 'toolResult',
        toolName: 'todowrite',
        details: { todos: [{ content: 'wrong', status: 'invalid', priority: 'high' }] },
      },
    ]),
  ).toEqual([]);
});
