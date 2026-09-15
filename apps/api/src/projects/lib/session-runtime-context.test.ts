import { describe, expect, test } from 'bun:test';
import {
  SESSION_RUNTIME_CONTEXT_ENV_NAME,
  mergeSessionSandboxEnv,
  parseSessionRuntimeContext,
  serializeSessionRuntimeContext,
} from './session-runtime-context';

describe('session runtime context boundaries', () => {
  test('extra env cannot select an agent runtime or claim an existing environment workspace', () => {
    const base = { KORTIX_WORKLOAD: 'environment', KORTIX_WARM_SEED: '0' };
    expect(mergeSessionSandboxEnv(base, {
      KORTIX_WORKLOAD: 'session', KORTIX_WARM_SEED: '1',
      KORTIX_ENVIRONMENT_REUSE_WORKSPACE: '1',
    })).toEqual(base);
  });
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

  test('trusted internal extras cannot shadow or invent the immutable Pi artifact selector', () => {
    const base = {
      KORTIX_PI_RUNTIME_REF: 'main',
      KORTIX_PI_RUNTIME_SHA: 'a'.repeat(40),
    };
    expect(
      mergeSessionSandboxEnv(base, {
        KORTIX_PI_RUNTIME_REF: 'forged-ref',
        KORTIX_PI_RUNTIME_SHA: 'b'.repeat(40),
      }),
    ).toEqual(base);
    expect(
      mergeSessionSandboxEnv({}, {
        KORTIX_PI_RUNTIME_REF: 'forged-ref',
        KORTIX_PI_RUNTIME_SHA: 'b'.repeat(40),
      }),
    ).toEqual({});
  });
});
