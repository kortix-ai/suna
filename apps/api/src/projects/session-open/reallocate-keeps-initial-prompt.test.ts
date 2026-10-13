/**
 * A box re-allocated before the first one ever ran must carry the session's
 * initial prompt again.
 *
 * Release gate, 2026-10-11: a first provision hit "The sandbox provider is at
 * capacity", `/start` deleted the failed row and re-allocated, and the new box
 * booted with no initial turn. The daemon claims the prompt only from a
 * `delivering` turn on the sandbox row (`activeTurns`), so the session came up
 * idle with zero messages and the boot prompt never ran (5 of 7 gate failures
 * "Timed out waiting for the boot prompt's turn to end").
 */
import { beforeEach, expect, mock, test } from 'bun:test';

const allocated: Array<{ initialTurn?: { token: string } | null }> = [];
// Spread the real module first: a bare factory drops every export the importers read.
const realAllocator = await import('../lib/session-runtime-allocator');
const realTransitions = await import('../session-lifecycle/status-transitions');
const realSessions = await import('../lib/sessions');
const realGit = await import('../lib/git');
mock.module('../lib/session-runtime-allocator', () => ({
  ...realAllocator,
  allocateSessionRuntime: (input: { initialTurn?: { token: string } | null }) => allocated.push(input),
}));
mock.module('../session-lifecycle/status-transitions', () => ({ ...realTransitions, transitionSession: async () => {} }));
mock.module('../lib/sessions', () => ({
  ...realSessions,
  buildSessionSandboxEnvVars: async () => ({}),
  sandboxCallbackUnreachableReason: () => null,
}));
mock.module('../lib/git', () => ({ ...realGit, withProjectGitAuth: async (row: unknown) => row }));

const { allocateRuntimeOnOpen } = await import('./session-open-provision');
const { config } = await import('../../config');

const loaded = {
  row: { accountId: 'a', projectId: 'p', defaultBranch: 'main', metadata: {} },
  userId: 'u',
} as never;
const visible = (over: Record<string, unknown>) =>
  ({
    sandboxProvider: config.ALLOWED_SANDBOX_PROVIDERS[0],
    baseRef: 'main',
    agentName: 'kortix',
    runtimeSessionId: null,
    metadata: { initial_prompt: 'say hello' },
    ...over,
  }) as never;

beforeEach(() => {
  allocated.length = 0;
});

test('a session that never ran its first prompt re-arms it on the new box', async () => {
  await allocateRuntimeOnOpen(loaded, visible({}), 'p', 's');
  expect(allocated).toHaveLength(1);
  expect(allocated[0].initialTurn?.token).toBeString();
});

test('a session that already has a runtime does not run its first prompt again', async () => {
  await allocateRuntimeOnOpen(loaded, visible({ runtimeSessionId: 'ses_1' }), 'p', 's');
  expect(allocated[0].initialTurn ?? null).toBeNull();
});

test('a session created without a prompt gets no initial turn', async () => {
  await allocateRuntimeOnOpen(loaded, visible({ metadata: {} }), 'p', 's');
  expect(allocated[0].initialTurn ?? null).toBeNull();
});
