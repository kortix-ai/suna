/**
 * The device-code adapter registry (spec §6.3) — proves the new
 * `/oauth-credentials/*` routes drive OpenAI Codex through the SAME underlying
 * `codex-device-auth` calls the old `/oauth/openai/*` routes use, and that an
 * unwired provider (Copilot/xAI, Phase 2) resolves to no adapter rather than a
 * fabricated one.
 *
 * `openai-codex.ts` transitively imports the DB/config-touching credential-
 * store + serializers; both are mocked so this runs env-free (the established
 * bare-`bun test` idiom in this repo).
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';

let startCalls = 0;
let pollArgs: { deviceAuthId: string; userCode: string } | null = null;

mock.module('../../../projects/codex-device-auth', () => ({
  startCodexDeviceAuth: async () => {
    startCalls += 1;
    return {
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'WXYZ-1234',
      deviceAuthId: 'dev-abc',
      intervalMs: 5000,
    };
  },
  pollCodexDeviceAuth: async (input: { deviceAuthId: string; userCode: string }) => {
    pollArgs = input;
    return { status: 'pending' as const };
  },
}));

mock.module('../../../projects/lib/serializers', () => ({
  CODEX_AUTH_JSON_SECRET_NAME: 'CODEX_AUTH_JSON',
}));

mock.module('./credential-store', () => ({
  oauthAuthExpiresInMs: (raw: string) => {
    try {
      return JSON.parse(raw).openai.expires - 1000;
    } catch {
      return null;
    }
  },
}));

const { deviceFlowAdapter } = await import('./device-flow');

/** The Codex adapter, guarded so tests read a defined value without `!`. */
function codexAdapter() {
  const adapter = deviceFlowAdapter('openai');
  if (!adapter) throw new Error('expected the OpenAI Codex device adapter to be registered');
  return adapter;
}

afterAll(() => mock.restore());

describe('deviceFlowAdapter', () => {
  test('OpenAI Codex is registered under provider id "openai"', () => {
    const adapter = deviceFlowAdapter('openai');
    expect(adapter).toBeDefined();
    expect(adapter?.providerId).toBe('openai');
    expect(adapter?.secretName).toBe('CODEX_AUTH_JSON');
  });

  test('an unwired provider (Phase 2) has no adapter', () => {
    expect(deviceFlowAdapter('github-copilot')).toBeUndefined();
    expect(deviceFlowAdapter('xai')).toBeUndefined();
  });

  test('start() delegates to the shipped codex device grant', async () => {
    const before = startCalls;
    const result = await codexAdapter().start();
    expect(startCalls).toBe(before + 1);
    expect(result).toEqual({
      deviceAuthId: 'dev-abc',
      userCode: 'WXYZ-1234',
      verificationUrl: 'https://auth.openai.com/codex/device',
      intervalMs: 5000,
    });
  });

  test('poll() forwards the device id + user code unchanged', async () => {
    const result = await codexAdapter().poll({
      deviceAuthId: 'dev-abc',
      userCode: 'WXYZ-1234',
    });
    expect(pollArgs).toEqual({ deviceAuthId: 'dev-abc', userCode: 'WXYZ-1234' });
    expect(result.status).toBe('pending');
  });

  test('expiresInMs reads the OpenCode auth.json expiry', () => {
    const authJson = JSON.stringify({ openai: { expires: Date.now() + 60_000 } });
    const ms = codexAdapter().expiresInMs(authJson);
    expect(typeof ms).toBe('number');
  });
});
