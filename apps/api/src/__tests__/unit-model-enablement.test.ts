import { describe, expect, it, mock } from 'bun:test';

const config: Record<string, unknown> = {};
mock.module('../config', () => ({ config }));

let policy: { modelOverrides: Record<string, boolean> } | null = null;
mock.module('../repositories/project-routing-policies', () => ({
  getProjectRoutingPolicy: async () => policy,
}));

const TODAY = new Date().toISOString().slice(0, 10);

// Two Anthropic families: one current, one stale. Enough to observe "newest of
// each family, within the window".
const CATALOG = {
  'anthropic/claude-sonnet-5': { family: 'claude-5', provider: 'anthropic', released: TODAY },
  'anthropic/claude-sonnet-4-6': {
    family: 'claude-5',
    provider: 'anthropic',
    released: '2026-01-01',
  },
  'anthropic/claude-opus-4-1': {
    family: 'claude-4',
    provider: 'anthropic',
    released: '2025-01-01',
  },
};

const { defaultEnabledFromCatalog, resolveEnablement, isModelEnabledForProject } = await import(
  '../llm-gateway/model-enablement'
);

describe('model-enablement', () => {
  it('offers the newest model of each in-window family by default', () => {
    const set = defaultEnabledFromCatalog(CATALOG);
    expect(set.has('anthropic/claude-sonnet-5')).toBe(true);
    // Superseded within its family, and a family whose newest is stale.
    expect(set.has('anthropic/claude-sonnet-4-6')).toBe(false);
    expect(set.has('anthropic/claude-opus-4-1')).toBe(false);
  });

  it('resolves a whole catalog with no overrides straight from the default', () => {
    config.MODEL_ENABLEMENT_ENABLED = true;
    const enabled = resolveEnablement(CATALOG, {});
    expect(enabled.get('anthropic/claude-sonnet-5')).toBe(true);
    expect(enabled.get('anthropic/claude-opus-4-1')).toBe(false);
  });

  it('lets an override turn a non-default model on and a default model off', () => {
    config.MODEL_ENABLEMENT_ENABLED = true;
    const enabled = resolveEnablement(CATALOG, {
      'anthropic/claude-opus-4-1': true,
      'anthropic/claude-sonnet-5': false,
    });
    expect(enabled.get('anthropic/claude-opus-4-1')).toBe(true);
    expect(enabled.get('anthropic/claude-sonnet-5')).toBe(false);
  });

  it('keeps offering newly-released models after a project has made overrides', () => {
    // THE reason overrides are stored instead of the resolved set: a project
    // that once toggled something must not have to hand-enable every future
    // model. A brand-new family the project has never seen is on by default.
    config.MODEL_ENABLEMENT_ENABLED = true;
    const withNewModel = {
      ...CATALOG,
      'anthropic/claude-opus-6': { family: 'claude-6', provider: 'anthropic', released: TODAY },
    };
    const enabled = resolveEnablement(withNewModel, { 'anthropic/claude-opus-4-1': true });
    expect(enabled.get('anthropic/claude-opus-6')).toBe(true);
  });

  it('offers a newly connected provider without any manual clicking', () => {
    config.MODEL_ENABLEMENT_ENABLED = true;
    const withOpenai = {
      ...CATALOG,
      'openai/gpt-5.5': { family: 'gpt-5', provider: 'openai', released: TODAY },
    };
    const enabled = resolveEnablement(withOpenai, { 'anthropic/claude-sonnet-5': false });
    expect(enabled.get('openai/gpt-5.5')).toBe(true);
  });

  it('offers everything when the feature flag is off, on both halves', async () => {
    config.MODEL_ENABLEMENT_ENABLED = false;
    policy = { modelOverrides: { 'anthropic/claude-opus-4-1': false } };
    // The picker projection and the gateway check must agree, or the picker
    // shows a model the gateway refuses.
    expect(resolveEnablement(CATALOG, policy.modelOverrides).get('anthropic/claude-opus-4-1')).toBe(
      true,
    );
    expect(await isModelEnabledForProject('p', 'anthropic/claude-opus-4-1', CATALOG)).toBe(true);
  });

  it('enforces the project overrides at the gateway', async () => {
    config.MODEL_ENABLEMENT_ENABLED = true;
    policy = { modelOverrides: { 'anthropic/claude-sonnet-5': false } };
    expect(await isModelEnabledForProject('p', 'anthropic/claude-sonnet-5', CATALOG)).toBe(false);
    // No override → the default decides.
    expect(await isModelEnabledForProject('p', 'anthropic/claude-opus-4-1', CATALOG)).toBe(false);
  });

  it('applies the default when the project has no policy row at all', async () => {
    config.MODEL_ENABLEMENT_ENABLED = true;
    policy = null;
    expect(await isModelEnabledForProject('p', 'anthropic/claude-sonnet-5', CATALOG)).toBe(true);
    expect(await isModelEnabledForProject('p', 'anthropic/claude-opus-4-1', CATALOG)).toBe(false);
  });

  it('offers everything when there is no project to scope the overrides to', async () => {
    config.MODEL_ENABLEMENT_ENABLED = true;
    policy = { modelOverrides: { 'glm-5.2': false } };
    expect(await isModelEnabledForProject(null, 'glm-5.2', CATALOG)).toBe(true);
    expect(await isModelEnabledForProject(undefined, 'glm-5.2', CATALOG)).toBe(true);
  });
});
