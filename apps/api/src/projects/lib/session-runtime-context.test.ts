import { describe, expect, test } from 'bun:test';
import {
  SESSION_RUNTIME_CONTEXT_ENV_NAME,
  mergeSessionSandboxEnv,
  parseSessionRuntimeContext,
  serializeSessionRuntimeContext,
} from './session-runtime-context';

describe('session runtime context boundaries', () => {
  test('serializes one deterministic JSON envelope, never per-key env vars', () => {
    const context = { workspace_id: 'org_123', locale: 'de', licensed: true };
    const serialized = serializeSessionRuntimeContext(context);
    expect(JSON.parse(serialized)).toEqual(context);
    const env = mergeSessionSandboxEnv({
      [SESSION_RUNTIME_CONTEXT_ENV_NAME]: serialized,
    });
    expect(env).toEqual({ KORTIX_SESSION_CONTEXT: serialized });
    expect(env).not.toHaveProperty('workspace_id');
    expect(env).not.toHaveProperty('locale');
  });

  test('rejects invalid internal values at the same boundary as public input', () => {
    expect(parseSessionRuntimeContext({ workspace_id: { nested: true } }).ok).toBe(false);
    expect(parseSessionRuntimeContext({ KORTIX_TOKEN: 'shadow' }).ok).toBe(false);
    expect(parseSessionRuntimeContext({ workspace_token: 'secret' }).ok).toBe(false);
  });

  test('trusted internal extras cannot shadow or invent KORTIX_SESSION_CONTEXT', () => {
    const base = { KORTIX_SESSION_CONTEXT: '{"workspace_id":"org_a"}', OTHER: 'base' };
    expect(
      mergeSessionSandboxEnv(base, {
        KORTIX_SESSION_CONTEXT: '{"workspace_id":"org_b"}',
        OTHER: 'extra',
      }),
    ).toEqual({
      KORTIX_SESSION_CONTEXT: '{"workspace_id":"org_a"}',
      OTHER: 'extra',
    });
    expect(
      mergeSessionSandboxEnv({ OTHER: 'base' }, { KORTIX_SESSION_CONTEXT: 'invented' }),
    ).toEqual({ OTHER: 'base' });
  });

  test('trusted internal extras cannot shadow or invent the secret capability catalog', () => {
    const catalog = '{"version":1,"capabilities":[]}';
    expect(
      mergeSessionSandboxEnv(
        { KORTIX_SECRET_CAPABILITIES: catalog },
        { KORTIX_SECRET_CAPABILITIES: '{"forged":true}' },
      ),
    ).toEqual({ KORTIX_SECRET_CAPABILITIES: catalog });
    expect(
      mergeSessionSandboxEnv({}, { KORTIX_SECRET_CAPABILITIES: '{"forged":true}' }),
    ).toEqual({});
  });
});

describe('subproject env is server-owned', () => {
  test('trusted internal extras cannot forge, move, or erase a subproject binding', () => {
    const envelope = '{"version":1,"slug":"marketing"}';
    // Forging one for a session the server put in no subproject.
    expect(
      mergeSessionSandboxEnv(
        {},
        { KORTIX_SUBPROJECT: 'marketing', KORTIX_SUBPROJECT_CONTEXT: envelope },
      ),
    ).toEqual({});
    // Moving a session into a different subproject.
    expect(
      mergeSessionSandboxEnv(
        { KORTIX_SUBPROJECT: 'marketing', KORTIX_SUBPROJECT_CONTEXT: envelope },
        { KORTIX_SUBPROJECT: 'finance', KORTIX_SUBPROJECT_CONTEXT: '{"version":1,"slug":"finance"}' },
      ),
    ).toEqual({ KORTIX_SUBPROJECT: 'marketing', KORTIX_SUBPROJECT_CONTEXT: envelope });
  });
});
