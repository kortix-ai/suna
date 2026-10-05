// The runtime catalog reads a harness may not serve stay off until its
// `/kortix/health` capabilities say it does: pi has no slash commands and no
// runtime config document, so their queries must never fire against it.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let supported = new Set<string>();
let seen: { key: unknown[]; enabled: boolean }[] = [];

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: { queryKey: unknown[]; enabled?: boolean }) => {
    seen.push({ key: config.queryKey, enabled: config.enabled !== false });
    return { data: undefined };
  },
  useMutation: () => ({}),
  useQueryClient: () => ({}),
}));

const realKeys = await import('./use-opencode-sessions/keys');
mock.module('./use-opencode-sessions/keys', () => ({ ...realKeys, useRuntimeReady: () => true }));
mock.module('./use-runtime-supports', () => ({
  useRuntimeSupports: (capability: string) => supported.has(capability),
}));

const { useRuntimeCommands } = await import('./use-opencode-sessions/commands');
const { useRuntimeConfig } = await import('./use-opencode-config');
const { useRuntimeSessionTodo } = await import('./use-opencode-sessions/sessions');

beforeEach(() => {
  supported = new Set();
  seen = [];
});

describe('runtime capability gates', () => {
  test('slash commands load only when the runtime serves session.commands', () => {
    useRuntimeCommands();
    supported.add('session.commands');
    useRuntimeCommands();
    expect(seen.map((q) => q.enabled)).toEqual([false, true]);
  });

  test('the runtime config document loads only when the runtime serves session.config', () => {
    useRuntimeConfig();
    supported.add('session.config');
    useRuntimeConfig();
    expect(seen.map((q) => q.enabled)).toEqual([false, true]);
  });

  test('the todo list loads only when the runtime serves session.todo', () => {
    useRuntimeSessionTodo('ses_1');
    supported.add('session.todo');
    useRuntimeSessionTodo('ses_1');
    expect(seen.map((q) => q.enabled)).toEqual([false, true]);
  });
});
