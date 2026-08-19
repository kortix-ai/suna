import { describe, expect, it, mock } from 'bun:test';

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

// glm-5.2 is the PLATFORM DEFAULT and, like every managed model, publishes no
// release date or family — see the regression test below.
mock.module('../llm-gateway/models/managed-models', () => ({
  isKnownManagedModelId: (id: string) => id === 'glm-5.2' || id === 'claude-opus-4.8',
}));

const { defaultEnabledFromCatalog, resolveEnablement } = await import(
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
    const enabled = resolveEnablement(CATALOG, {});
    expect(enabled.get('anthropic/claude-sonnet-5')).toBe(true);
    expect(enabled.get('anthropic/claude-opus-4-1')).toBe(false);
  });

  it('lets an override turn a non-default model on and a default model off', () => {
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
    const withNewModel = {
      ...CATALOG,
      'anthropic/claude-opus-6': { family: 'claude-6', provider: 'anthropic', released: TODAY },
    };
    const enabled = resolveEnablement(withNewModel, { 'anthropic/claude-opus-4-1': true });
    expect(enabled.get('anthropic/claude-opus-6')).toBe(true);
  });

  it('never prunes a managed model, however thin its catalog metadata', () => {
    // REGRESSION: managed models are hand-curated and publish no `released` or
    // `family`, so the recency rule dropped every one of them — including
    // glm-5.2, the PLATFORM DEFAULT — and `auto` resolved to a hidden model.
    const withManaged = { ...CATALOG, 'glm-5.2': {}, 'claude-opus-4.8': {} };
    const set = defaultEnabledFromCatalog(withManaged);
    expect(set.has('glm-5.2')).toBe(true);
    expect(set.has('claude-opus-4.8')).toBe(true);
  });

  it('never prunes a model the project is configured to route to', () => {
    // A stale BYOK model set as the project default (or a routing-rule target)
    // must stay offered — hiding it would hide the model the project's own
    // settings resolve to.
    const set = defaultEnabledFromCatalog(CATALOG, ['anthropic/claude-opus-4-1']);
    expect(set.has('anthropic/claude-opus-4-1')).toBe(true);
  });

  it('offers a newly connected provider without any manual clicking', () => {
    const withOpenai = {
      ...CATALOG,
      'openai/gpt-5.5': { family: 'gpt-5', provider: 'openai', released: TODAY },
    };
    const enabled = resolveEnablement(withOpenai, { 'anthropic/claude-sonnet-5': false });
    expect(enabled.get('openai/gpt-5.5')).toBe(true);
  });
});
