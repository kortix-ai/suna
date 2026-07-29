import { describe, expect, it, mock } from 'bun:test';

const config: Record<string, unknown> = {};
mock.module('../config', () => ({ config }));

let policy: { disabledModels: string[] } | null = null;
mock.module('../repositories/project-routing-policies', () => ({
  getProjectRoutingPolicy: async () => policy,
}));

const { getProjectDisabledModels, isModelDisabledForProject } = await import(
  '../llm-gateway/model-enablement'
);

describe('model-enablement', () => {
  it('returns nothing disabled when the feature flag is off', async () => {
    config.MODEL_ENABLEMENT_ENABLED = false;
    policy = { disabledModels: ['glm-5.2'] };
    expect((await getProjectDisabledModels('p')).size).toBe(0);
    expect(await isModelDisabledForProject('p', 'glm-5.2')).toBe(false);
  });

  it('returns the project disabled set when on', async () => {
    config.MODEL_ENABLEMENT_ENABLED = true;
    policy = { disabledModels: ['glm-5.2', 'codex/gpt-5.4'] };
    const set = await getProjectDisabledModels('p');
    expect(set.has('glm-5.2')).toBe(true);
    expect(await isModelDisabledForProject('p', 'codex/gpt-5.4')).toBe(true);
    expect(await isModelDisabledForProject('p', 'anthropic/claude-sonnet-5')).toBe(false);
  });

  it('short-circuits with no project or no policy', async () => {
    config.MODEL_ENABLEMENT_ENABLED = true;
    policy = null;
    expect(await isModelDisabledForProject(null, 'glm-5.2')).toBe(false);
    expect(await isModelDisabledForProject(undefined, 'glm-5.2')).toBe(false);
    expect((await getProjectDisabledModels('p')).size).toBe(0);
  });
});
