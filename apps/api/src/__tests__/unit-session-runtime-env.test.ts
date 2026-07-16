import { describe, expect, test } from 'bun:test';

import { buildSessionRuntimeEnv } from '../projects/lib/session-runtime-env';

const base = {
  projectId: 'proj-1',
  sessionId: 'sess-1',
  repoUrl: 'https://github.com/kortix/project.git',
  baseRef: 'main',
  agentName: 'default',
  apiUrl: 'https://api.kortix.test/v1',
};

describe('buildSessionRuntimeEnv', () => {
  test('always asks the sandbox daemon to bootstrap the OpenCode root', () => {
    const env = buildSessionRuntimeEnv(base);

    expect(env.KORTIX_BOOTSTRAP_OPENCODE_SESSION).toBe('1');
    expect(env.KORTIX_INITIAL_PROMPT).toBeUndefined();
    expect(env.KORTIX_REPO_URL).toBe(base.repoUrl);
    expect(env.KORTIX_BRANCH_NAME).toBe(base.sessionId);
  });

  test('adds first-turn and model payload without changing root ownership', () => {
    const env = buildSessionRuntimeEnv({
      ...base,
      initialPrompt: 'answer this Slack thread',
      runtimeModel: 'anthropic/claude-sonnet-4-6',
    });

    expect(env.KORTIX_BOOTSTRAP_OPENCODE_SESSION).toBe('1');
    expect(env.KORTIX_INITIAL_PROMPT).toBe('answer this Slack thread');
    expect(env.KORTIX_OPENCODE_MODEL).toBe('anthropic/claude-sonnet-4-6');
  });

  test('legacy path dual-emits the harness-neutral env twins alongside the legacy names, same value', () => {
    const env = buildSessionRuntimeEnv({
      ...base,
      initialPrompt: 'answer this Slack thread',
      runtimeModel: 'anthropic/claude-sonnet-4-6',
    });

    // Legacy names — never removed, old sandbox images still bootstrap off these.
    expect(env.KORTIX_BOOTSTRAP_OPENCODE_SESSION).toBe('1');
    expect(env.KORTIX_OPENCODE_MODEL).toBe('anthropic/claude-sonnet-4-6');
    // Neutral twins — same values, dual-emitted, not a replacement.
    expect(env.KORTIX_BOOTSTRAP_RUNTIME_SESSION).toBe('1');
    expect(env.KORTIX_RUNTIME_MODEL).toBe('anthropic/claude-sonnet-4-6');
  });

  test('legacy path with no runtimeModel omits both the legacy and neutral model keys', () => {
    const env = buildSessionRuntimeEnv(base);
    expect(env.KORTIX_OPENCODE_MODEL).toBeUndefined();
    expect(env.KORTIX_RUNTIME_MODEL).toBeUndefined();
  });
});
