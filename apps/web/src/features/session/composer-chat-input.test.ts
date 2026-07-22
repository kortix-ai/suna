import { describe, expect, test } from 'bun:test';
import {
  AUTO_CATALOG_MODEL,
  boundSessionAgentName,
  buildComposerOptions,
  capFeedModels,
  catalogAgentModelKey,
  catalogSessionModelKey,
  firstModelOptionValue,
  isAutoCatalogModel,
  otherConfigOptionDeferredKey,
  presetToFlatModel,
  resolveDisplayCatalogModel,
  resolveExplicitCatalogModel,
  resolvePresetProviderId,
} from './composer-chat-input';

describe('harness-aware composer options', () => {
  test('locks an existing session to its persisted logical agent', () => {
    expect(boundSessionAgentName('  claude  ')).toBe('claude');
    expect(boundSessionAgentName(null)).toBeNull();
  });

  // Pi is gateway/catalog-driven since the 2026-07-21 refactor (0b86e10f2) —
  // only Claude Code and Codex own their model natively.
  for (const harness of ['claude', 'codex'] as const) {
    test(`${harness} sends the agent without a stale gateway model override`, () => {
      expect(
        buildComposerOptions({
          agent: { name: harness, harness },
          model: { providerID: 'kortix', modelID: 'openai/gpt-5.4' },
        }),
      ).toEqual({ agent: harness });
    });
  }

  // *** THE `default`-model leak (live-reproduced on Claude Code, 2026-07-22) ***
  // A harness-owned harness's model value (`default`/`opus`/`sonnet`/`haiku`
  // for Claude; `gpt-5.x` for Codex) is an ACP config-option value applied via
  // `session/set_config_option`, NOT a gateway catalog model. It must therefore
  // ride ONLY in `runtimeModel` (the ACP field) and NEVER in
  // `model_selection.model_id` (which the server stamps onto `metadata.model`
  // and resolves against the gateway catalog — where `default` does not exist,
  // producing "There's an issue with the selected model (default)..."). So
  // `model_selection.kind` is always `'default'` with a `null` `modelId` for
  // these harnesses, regardless of which native value is picked.
  for (const harness of ['claude', 'codex'] as const) {
    test(`${harness} carries an explicit harness-native model without a gateway model key`, () => {
      expect(
        buildComposerOptions({
          agent: { name: harness, harness },
          model: { providerID: 'kortix', modelID: 'stale/model' },
          runtimeModel: ' native/model ',
        }),
      ).toEqual({
        agent: harness,
        runtimeModel: 'native/model',
        modelSelection: {
          kind: 'default',
          modelId: null,
          connectionId: null,
        },
      });
    });
  }

  // Every real claude-agent-acp `model` config-option value (verified live,
  // `kortix.acp_session_envelopes`) — `default` is the exact one that 400s at
  // the gateway; the rest only "worked" incidentally. NONE may become a gateway
  // `model_id`.
  for (const native of ['default', 'opus', 'sonnet', 'haiku'] as const) {
    test(`claude '${native}' never reaches gateway catalog validation (kind stays 'default', no model_id)`, () => {
      const options = buildComposerOptions({
        agent: { name: 'claude', harness: 'claude' },
        runtimeModel: native,
        connectionId: 'claude_subscription',
        // Even if a preset list happens to contain the native token, it must
        // NOT be classified as a `preset` and sent as a gateway model.
        presets: [{ id: native }],
      });
      expect(options.model).toBeUndefined();
      expect(options.runtimeModel).toBe(native);
      expect(options.modelSelection).toEqual({
        kind: 'default',
        modelId: null,
        connectionId: 'claude_subscription',
      });
    });
  }

  test('claude with a connection but no explicit pick sends kind default and no model_id', () => {
    expect(
      buildComposerOptions({
        agent: { name: 'claude', harness: 'claude' },
        connectionId: 'claude_subscription',
      }),
    ).toEqual({
      agent: 'claude',
      connectionId: 'claude_subscription',
      modelSelection: { kind: 'default', modelId: null, connectionId: 'claude_subscription' },
    });
  });

  test('OpenCode retains the selected catalog model', () => {
    expect(
      buildComposerOptions({
        agent: { name: 'kortix', harness: 'opencode' },
        model: { providerID: 'kortix', modelID: 'openai/gpt-5.4' },
      }),
    ).toEqual({
      agent: 'kortix',
      model: { providerID: 'kortix', modelID: 'openai/gpt-5.4' },
      modelSelection: {
        kind: 'custom',
        modelId: 'kortix/openai/gpt-5.4',
        connectionId: null,
      },
    });
  });

  test('Pi retains the selected catalog model — catalog-driven since 0b86e10f2', () => {
    expect(
      buildComposerOptions({
        agent: { name: 'pi', harness: 'pi' },
        model: { providerID: 'kortix', modelID: 'openai/gpt-5.4' },
      }),
    ).toEqual({
      agent: 'pi',
      model: { providerID: 'kortix', modelID: 'openai/gpt-5.4' },
      modelSelection: {
        kind: 'custom',
        modelId: 'kortix/openai/gpt-5.4',
        connectionId: null,
      },
    });
  });

  test('OpenCode ignores a stale harness-native model', () => {
    expect(
      buildComposerOptions({
        agent: { name: 'kortix', harness: 'opencode' },
        runtimeModel: 'native/model',
      }),
    ).toEqual({ agent: 'kortix' });
  });

  // AUTO is the MANAGED DEFAULT, never an explicit catalog id — it must send
  // `kind: 'default'` with NO model_id (letting the server resolve it), never
  // a `custom`/`preset` `model_id: 'kortix/auto'` that the create path would
  // stamp onto `metadata.model` and validate as a concrete catalog model.
  test('OpenCode defaulted to AUTO sends kind:default with no model_id', () => {
    expect(
      buildComposerOptions({
        agent: { name: 'kortix', harness: 'opencode' },
        model: AUTO_CATALOG_MODEL,
        connectionId: 'managed_gateway',
      }),
    ).toEqual({
      agent: 'kortix',
      connectionId: 'managed_gateway',
      modelSelection: { kind: 'default', modelId: null, connectionId: 'managed_gateway' },
    });
  });
});

// Regression coverage for the "providerID mis-tag" bug: a project routed
// through `anthropic_api_key` returned 6 real, `can_start: true` presets with
// BARE ids (no `/` — see `modelPresets()` in
// apps/api/src/projects/lib/composer-capabilities.ts), but the picker showed
// "No models available" because the bare id's `providerID` defaulted to the
// HARNESS name (`opencode`) instead of the real upstream provider
// (`anthropic`) that main's `ModelSelector` filters visibility against (see
// `connectedGatewayProviderIdsFromSecretNames`).
describe('resolvePresetProviderId', () => {
  test('the server-stamped `provider` field (verified live: every modelPresets() branch sets it) always wins', () => {
    expect(
      resolvePresetProviderId({
        presetId: 'claude-sonnet-5',
        presetProvider: 'anthropic',
        connectionKind: null,
        harnessFallback: 'opencode',
      }),
    ).toBe('anthropic');
  });

  test('a bare anthropic_api_key preset id with no `provider` field resolves to the real provider, never the harness', () => {
    expect(
      resolvePresetProviderId({
        presetId: 'claude-sonnet-5',
        connectionKind: 'anthropic_api_key',
        harnessFallback: 'opencode',
      }),
    ).toBe('anthropic');
  });

  test('a bare openai_api_key preset id resolves to openai', () => {
    expect(
      resolvePresetProviderId({
        presetId: 'gpt-5.4',
        connectionKind: 'openai_api_key',
        harnessFallback: 'opencode',
      }),
    ).toBe('openai');
  });

  test('a namespaced preset id (managed_gateway/native_config) splits on "/" regardless of connection kind', () => {
    expect(
      resolvePresetProviderId({
        presetId: 'kortix/auto',
        connectionKind: 'managed_gateway',
        harnessFallback: 'opencode',
      }),
    ).toBe('kortix');
    expect(
      resolvePresetProviderId({
        presetId: 'anthropic/claude-sonnet-5',
        connectionKind: 'native_config',
        harnessFallback: 'claude',
      }),
    ).toBe('anthropic');
  });

  test('a bare id under a connection kind with no known real-provider mapping falls back to the harness', () => {
    expect(
      resolvePresetProviderId({
        presetId: 'custom-model',
        connectionKind: 'openai_compatible',
        harnessFallback: 'pi',
      }),
    ).toBe('pi');
    expect(
      resolvePresetProviderId({
        presetId: 'claude-sonnet-4-6',
        connectionKind: null,
        harnessFallback: 'claude',
      }),
    ).toBe('claude');
  });
});

describe('presetToFlatModel', () => {
  test('reads the real project bafd5d7c-7fac-4e5c-a274-db73c5da4e39 shape returned live by the running dev API: opencode routed through anthropic_api_key, 6 stamped presets', () => {
    // Captured live from apps/api/src/projects/lib/composer-capabilities.ts's
    // `modelPresets('anthropic_api_key', ...)` against this dev stack.
    const model = presetToFlatModel(
      {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        source: 'models.dev',
        provider: 'anthropic',
      },
      { connectionKind: 'anthropic_api_key', harnessFallback: 'opencode' },
    );
    expect(model.providerID).toBe('anthropic');
    expect(model.modelID).toBe('claude-sonnet-5');
  });

  test('tags a bare anthropic_api_key preset as the real provider and carries catalog release metadata, even with no `provider` field (pre-refactor API shape)', () => {
    const model = presetToFlatModel(
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', source: 'models.dev' },
      { connectionKind: 'anthropic_api_key', harnessFallback: 'opencode' },
    );
    expect(model.providerID).toBe('anthropic');
    expect(model.modelID).toBe('claude-sonnet-5');
    expect(model.modelName).toBe('Claude Sonnet 5');
    // Real catalog entry — released/family should be populated (not asserting
    // exact values so this doesn't churn every catalog refresh).
    expect(model.releaseDate).toBeTruthy();
  });

  test('a kortix-namespaced preset skips the catalog lookup (gateway ids are not models.dev ids)', () => {
    const model = presetToFlatModel(
      { id: 'kortix/auto', name: 'Auto', source: 'kortix-gateway' },
      { connectionKind: 'managed_gateway', harnessFallback: 'opencode' },
    );
    expect(model.providerID).toBe('kortix');
    expect(model.modelID).toBe('auto');
    expect(model.releaseDate).toBeUndefined();
  });
});

// Regression coverage for the "4,941-model uncapped render lag" bug: a
// `managed_gateway` preset list is the gateway's entire routable catalog: it
// must stay capped at the feeding layer since main's `ModelSelector` has no
// cap of its own.
describe('capFeedModels', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    providerID: 'anthropic',
    providerName: 'Anthropic',
    modelID: `model-${i}`,
    modelName: `Model ${i}`,
  }));

  test('passes a list under the cap through unchanged', () => {
    expect(capFeedModels(many.slice(0, 10), null, 50)).toHaveLength(10);
  });

  test('caps a huge list to the given size', () => {
    expect(capFeedModels(many, null, 50)).toHaveLength(50);
  });

  test('the selected model is always present, even past the cap', () => {
    const selected = { providerID: 'anthropic', modelID: 'model-199' };
    const result = capFeedModels(many, selected, 50);
    expect(result).toHaveLength(51);
    expect(result.some((m) => m.providerID === 'anthropic' && m.modelID === 'model-199')).toBe(
      true,
    );
  });

  test('a selected model already within the cap is not duplicated', () => {
    const selected = { providerID: 'anthropic', modelID: 'model-0' };
    expect(capFeedModels(many, selected, 50)).toHaveLength(50);
  });
});

// Regression coverage for the "OpenCode model picker selection doesn't take
// effect" bug (2026-07-21): clicking a model persisted it via
// `useRuntimeLocal.model.set`, but the picker's `selectedModel` was read back
// through `useRuntimeLocal.model.currentKey`, which only resolves against
// `flattenModels(providers)` — a catalog where every model's `providerID` is
// literally `'kortix'`. Composer-capabilities presets (what the picker
// actually renders, via `presetToFlatModel`) carry the REAL resolved
// provider id instead (`'anthropic'`, `'openai'`, ...) for BYOK routes, and
// `kortix/`-prefixed but differently-shaped ids for managed routes — neither
// ever appears in `flattenModels(providers)`, so the pick could never read
// back as selected. `resolveExplicitCatalogModel` is the fix: it validates a
// persisted pick against the SAME catalog the picker renders
// (`capabilityModelsRaw`), not a foreign one.
describe('resolveExplicitCatalogModel', () => {
  test('a bare BYOK preset (anthropic_api_key, provider-tagged) round-trips: persisted matches the rendered catalog', () => {
    const models = [
      presetToFlatModel(
        {
          id: 'claude-sonnet-5',
          name: 'Claude Sonnet 5',
          source: 'models.dev',
          provider: 'anthropic',
        },
        { connectionKind: 'anthropic_api_key', harnessFallback: 'opencode' },
      ),
    ];
    const resolved = resolveExplicitCatalogModel({
      sessionModel: undefined,
      agentModel: { providerID: 'anthropic', modelID: 'claude-sonnet-5' },
      models,
    });
    expect(resolved).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-5' });
  });

  test('a `kortix/`-prefixed managed preset round-trips', () => {
    const models = [
      presetToFlatModel(
        { id: 'kortix/auto', name: 'Auto', source: 'kortix-gateway' },
        { connectionKind: 'managed_gateway', harnessFallback: 'opencode' },
      ),
    ];
    const resolved = resolveExplicitCatalogModel({
      sessionModel: undefined,
      agentModel: { providerID: 'kortix', modelID: 'auto' },
      models,
    });
    expect(resolved).toEqual({ providerID: 'kortix', modelID: 'auto' });
  });

  test('a stale/unknown persisted id degrades to undefined instead of wedging the picker', () => {
    const models = [
      presetToFlatModel(
        {
          id: 'claude-sonnet-5',
          name: 'Claude Sonnet 5',
          source: 'models.dev',
          provider: 'anthropic',
        },
        { connectionKind: 'anthropic_api_key', harnessFallback: 'opencode' },
      ),
    ];
    const resolved = resolveExplicitCatalogModel({
      sessionModel: undefined,
      agentModel: { providerID: 'openai', modelID: 'gpt-5.4-nonexistent' },
      models,
    });
    expect(resolved).toBeUndefined();
  });

  test('a pre-fix `useRuntimeLocal`-vocabulary value (always providerID "kortix") never cross-matches the composer-capabilities catalog', () => {
    const models = [
      presetToFlatModel(
        {
          id: 'claude-sonnet-5',
          name: 'Claude Sonnet 5',
          source: 'models.dev',
          provider: 'anthropic',
        },
        { connectionKind: 'anthropic_api_key', harnessFallback: 'opencode' },
      ),
    ];
    // This is exactly the shape `flattenModels(providers)` would have produced
    // for this same upstream model — the OLD (broken) identity this composer
    // no longer reads selection through.
    const resolved = resolveExplicitCatalogModel({
      sessionModel: undefined,
      agentModel: { providerID: 'kortix', modelID: 'anthropic/claude-sonnet-5' },
      models,
    });
    expect(resolved).toBeUndefined();
  });

  test('no persisted selection at all resolves to undefined (picker shows its default/unset state)', () => {
    const models = [
      presetToFlatModel(
        {
          id: 'claude-sonnet-5',
          name: 'Claude Sonnet 5',
          source: 'models.dev',
          provider: 'anthropic',
        },
        { connectionKind: 'anthropic_api_key', harnessFallback: 'opencode' },
      ),
    ];
    expect(
      resolveExplicitCatalogModel({ sessionModel: undefined, agentModel: undefined, models }),
    ).toBeUndefined();
  });

  test('a valid per-session pick wins over a valid per-agent pick', () => {
    const models = [
      presetToFlatModel(
        {
          id: 'claude-sonnet-5',
          name: 'Claude Sonnet 5',
          source: 'models.dev',
          provider: 'anthropic',
        },
        { connectionKind: 'anthropic_api_key', harnessFallback: 'opencode' },
      ),
      presetToFlatModel(
        { id: 'gpt-5.4', name: 'GPT-5.4', source: 'models.dev', provider: 'openai' },
        { connectionKind: 'openai_api_key', harnessFallback: 'opencode' },
      ),
    ];
    const resolved = resolveExplicitCatalogModel({
      sessionModel: { providerID: 'openai', modelID: 'gpt-5.4' },
      agentModel: { providerID: 'anthropic', modelID: 'claude-sonnet-5' },
      models,
    });
    expect(resolved).toEqual({ providerID: 'openai', modelID: 'gpt-5.4' });
  });

  test('an invalid per-session pick does not fall back to a valid per-agent pick (session, once present, is authoritative)', () => {
    const models = [
      presetToFlatModel(
        {
          id: 'claude-sonnet-5',
          name: 'Claude Sonnet 5',
          source: 'models.dev',
          provider: 'anthropic',
        },
        { connectionKind: 'anthropic_api_key', harnessFallback: 'opencode' },
      ),
    ];
    // Documented here so a future change to session-vs-agent precedence is a
    // deliberate decision, not a silent drift.
    const resolved = resolveExplicitCatalogModel({
      sessionModel: { providerID: 'openai', modelID: 'nonexistent' },
      agentModel: { providerID: 'anthropic', modelID: 'claude-sonnet-5' },
      models,
    });
    expect(resolved).toBeUndefined();
  });
});

// THE merge-regression fix: a catalog composer whose server capability reports
// it can start on the managed default (`default_allowed` === `can_start` ===
// `model.state === 'ready'`) must default its EFFECTIVE (display) model to AUTO
// — so the pill reads "Auto", never a blank "No model" with a live Send — while
// still sending `kind: 'default'` (no model_id) so the server resolves it. When
// the default is NOT allowed (e.g. no_credential), it stays null: the pill
// reads "No model" AND the capability gate blocks the Send. An explicit pick
// always wins over the AUTO default.
describe('resolveDisplayCatalogModel', () => {
  test('ready + default_allowed, no explicit pick → AUTO (pill reads "Auto")', () => {
    expect(
      resolveDisplayCatalogModel({
        explicitModel: null,
        catalogModelRequired: true,
        defaultAllowed: true,
      }),
    ).toEqual(AUTO_CATALOG_MODEL);
  });

  test('no_credential (default NOT allowed), no explicit pick → null (pill "No model", Send blocked)', () => {
    expect(
      resolveDisplayCatalogModel({
        explicitModel: null,
        catalogModelRequired: true,
        defaultAllowed: false,
      }),
    ).toBeNull();
  });

  test('an explicit pick always wins over the AUTO default', () => {
    const pick = { providerID: 'openai', modelID: 'gpt-5.4' };
    expect(
      resolveDisplayCatalogModel({
        explicitModel: pick,
        catalogModelRequired: true,
        defaultAllowed: true,
      }),
    ).toEqual(pick);
  });

  test('a non-catalog harness (claude/codex own their model) never defaults to AUTO here', () => {
    expect(
      resolveDisplayCatalogModel({
        explicitModel: null,
        catalogModelRequired: false,
        defaultAllowed: true,
      }),
    ).toBeNull();
  });
});

describe('isAutoCatalogModel', () => {
  test('recognises the AUTO sentinel and nothing else', () => {
    expect(isAutoCatalogModel(AUTO_CATALOG_MODEL)).toBe(true);
    expect(isAutoCatalogModel({ providerID: 'kortix', modelID: 'auto' })).toBe(true);
    expect(isAutoCatalogModel({ providerID: 'openai', modelID: 'gpt-5.4' })).toBe(false);
    expect(isAutoCatalogModel({ providerID: 'kortix', modelID: 'gpt-5.4' })).toBe(false);
    expect(isAutoCatalogModel(null)).toBe(false);
  });
});

describe('catalogAgentModelKey / catalogSessionModelKey', () => {
  test('keys are namespaced apart from `useRuntimeLocal`s own `${providerMode}:${name}` scheme', () => {
    expect(catalogAgentModelKey('kortix')).toBe('composer-capabilities-model:kortix');
    expect(catalogSessionModelKey('ses_123')).toBe('composer-capabilities-model:ses_123');
    // Never collides with `${providerMode}:${agentName}` (providerMode is
    // always 'native' or 'gateway' — see modelProviderMode).
    expect(catalogAgentModelKey('kortix')).not.toBe('gateway:kortix');
    expect(catalogAgentModelKey('kortix')).not.toBe('native:kortix');
  });
});

describe('firstModelOptionValue — the blank-pill fix (2026-07-22)', () => {
  test('the real claude fallback shape: first option is "default", matching its real live bootstrap currentValue', () => {
    expect(
      firstModelOptionValue({
        options: [
          { name: 'Default (recommended)', value: 'default' },
          { name: 'Sonnet', value: 'sonnet' },
        ],
      }),
    ).toBe('default');
  });

  test('the real codex fallback shape: first option is "gpt-5.6-sol", matching its real live bootstrap currentValue', () => {
    expect(
      firstModelOptionValue({
        options: [
          { name: 'GPT-5.6-Sol', value: 'gpt-5.6-sol' },
          { name: 'GPT-5.6-Terra', value: 'gpt-5.6-terra' },
        ],
      }),
    ).toBe('gpt-5.6-sol');
  });

  test('falls back to `id` when a choice has no `value`', () => {
    expect(firstModelOptionValue({ options: [{ id: 'only-id' }] })).toBe('only-id');
  });

  test('no options, or nothing passed at all: undefined, never throws', () => {
    expect(firstModelOptionValue({ options: [] })).toBeUndefined();
    expect(firstModelOptionValue(null)).toBeUndefined();
    expect(firstModelOptionValue(undefined)).toBeUndefined();
  });
});

describe('otherConfigOptionDeferredKey — generic pre-session store for mode/effort/etc (2026-07-22)', () => {
  test('composes agent name and option id, distinct per option', () => {
    expect(otherConfigOptionDeferredKey('claude', 'mode')).toBe('claude::config-option:mode');
    expect(otherConfigOptionDeferredKey('claude', 'effort')).toBe('claude::config-option:effort');
    expect(otherConfigOptionDeferredKey('claude', 'mode')).not.toBe(
      otherConfigOptionDeferredKey('claude', 'effort'),
    );
  });

  test('never collides with the bare per-agent key the model pick uses (`runtimeModelStore.getRuntimeModel(agentName)`)', () => {
    expect(otherConfigOptionDeferredKey('claude', 'mode')).not.toBe('claude');
  });

  test('distinct per agent, same option id', () => {
    expect(otherConfigOptionDeferredKey('claude', 'mode')).not.toBe(
      otherConfigOptionDeferredKey('codex', 'mode'),
    );
  });
});
