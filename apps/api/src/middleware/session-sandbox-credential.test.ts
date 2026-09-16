import { describe, expect, test } from 'bun:test';

import {
  getSessionRuntimeCredential,
  isSessionSandboxCredential,
} from './session-sandbox-credential';

function context(values: Record<string, unknown>) {
  return {
    get(key: string) {
      return values[key];
    },
  } as never;
}

describe('session runtime credentials', () => {
  test('identifies a worker PAT by its durable runtime id', () => {
    const c = context({
      authType: 'pat',
      sessionId: 'session-1',
      sandboxId: 'worker-1',
      sessionRuntimeKind: 'worker',
    });

    expect(getSessionRuntimeCredential(c)).toEqual({
      kind: 'worker',
      runtimeId: 'worker-1',
      sessionId: 'session-1',
    });
    expect(isSessionSandboxCredential(c)).toBe(true);
  });

  test('identifies an environment PAT without treating it as the worker', () => {
    const c = context({
      authType: 'pat',
      sessionId: 'session-1',
      sandboxId: 'environment-1',
      sessionRuntimeKind: 'environment',
    });

    expect(getSessionRuntimeCredential(c)).toEqual({
      kind: 'environment',
      runtimeId: 'environment-1',
      sessionId: 'session-1',
    });
    expect(isSessionSandboxCredential(c, 'worker')).toBe(false);
    expect(isSessionSandboxCredential(c, 'environment')).toBe(true);
  });

  test('keeps legacy session PATs as worker credentials during rollout', () => {
    const c = context({
      authType: 'pat',
      sessionId: 'session-1',
      sandboxId: 'session-1',
    });

    expect(getSessionRuntimeCredential(c)).toEqual({
      kind: 'worker',
      runtimeId: 'session-1',
      sessionId: 'session-1',
    });
  });

  test('rejects ordinary project PATs', () => {
    expect(getSessionRuntimeCredential(context({ authType: 'pat' }))).toBeNull();
  });
});
