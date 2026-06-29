import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Auto-seed-on-first-provider-connect. Only seeds when the account has NO model
// default yet and the provider flagship is servable; never clobbers an existing
// default; idempotent. The pure effective.ts (toWireModel) is used for real.

let flagshipRef: string | null = 'anthropic/claude-opus-4.8';
mock.module('./picker-catalog', () => ({ flagshipRefForEnvVar: () => flagshipRef }));

let defaults: any = { account: null, agents: {}, projects: {} };
const upsert = mock(async () => {});
mock.module('../../repositories/model-preferences', () => ({
  getAccountModelDefaults: async () => defaults,
  upsertAccountModelPreference: upsert,
}));

let servable = true;
const invalidate = mock(() => {});
mock.module('../resolution/default-model', () => ({
  isModelServableForAccount: async () => servable,
  invalidateAccountModelDefaults: invalidate,
}));

const { seedProjectDefaultModelOnConnect } = await import('./seed-default');

const params = { projectId: 'p1', accountId: 'a1', userId: 'u1', secretName: 'ANTHROPIC_API_KEY' };

beforeEach(() => {
  flagshipRef = 'anthropic/claude-opus-4.8';
  defaults = { account: null, agents: {}, projects: {} };
  servable = true;
  upsert.mockClear();
  invalidate.mockClear();
});

describe('seedProjectDefaultModelOnConnect', () => {
  test('seeds the provider flagship as the project default when nothing is set', async () => {
    await seedProjectDefaultModelOnConnect(params);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'a1',
        scope: 'project',
        scopeKey: 'p1',
        model: 'anthropic/claude-opus-4.8',
        onlyIfAbsent: true,
      }),
    );
    expect(invalidate).toHaveBeenCalledWith('a1');
  });

  test('skips a non-provider credential (flagship ref null)', async () => {
    flagshipRef = null;
    await seedProjectDefaultModelOnConnect({ ...params, secretName: 'CODEX_AUTH_JSON' });
    expect(upsert).not.toHaveBeenCalled();
  });

  test('never clobbers an existing account default', async () => {
    defaults = { account: 'glm-5.2', agents: {}, projects: {} };
    await seedProjectDefaultModelOnConnect(params);
    expect(upsert).not.toHaveBeenCalled();
  });

  test('never clobbers an existing project default', async () => {
    defaults = { account: null, agents: {}, projects: { p1: 'glm-5.2' } };
    await seedProjectDefaultModelOnConnect(params);
    expect(upsert).not.toHaveBeenCalled();
  });

  test('skips when the flagship is not servable', async () => {
    servable = false;
    await seedProjectDefaultModelOnConnect(params);
    expect(upsert).not.toHaveBeenCalled();
  });
});
