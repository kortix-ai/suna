import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG, bedrockInferenceProfileRank } from '@kortix/llm-catalog';
import { type FlatModel, flattenModels, isOfferedModel } from './model-flatten';
import { nativeProviderListFromCatalog, projectLlmCatalogToProviderList } from './provider-selection';
import { modelProviderMode } from './use-opencode-local';
import { healBedrockModelKey } from './bedrock-invokable';

// ── Why this exists ─────────────────────────────────────────────────────────
//
// The catalog-default fix (commit 2e3e843cbe) made
// `nativeProviderListFromCatalog` publish
// `default['amazon-bedrock'] = 'global.anthropic.claude-opus-5'`. Verified
// against the REAL catalog. Yet the deployed Essentia project-home composer
// still preselected "Grok 4.6" on a brand-new workspace.
//
// Because that default is only Priority 3 of the LAST source in the chain.
// `use-opencode-local.ts` resolves:
//   explicitModelKey > serverDefault > globalDefault > agent.model > fallback
// and `explicitModelKey` reads `modelStore.getSelectedModel(agentModelSlotKey)`
// where the slot key is `agentScopedModelSelectionKey(mode, agentName)` =
// `` `${mode}:${agentName ?? ''}` `` (use-opencode-local.ts:226-231) — NOT
// project-scoped. The project-home composer has no agent and no sessionId, so
// EVERY native project in a browser shares the single slot `native:`. One
// earlier session on `xai.grok-4.6` pins that bare id for every future
// workspace, above anything the catalog default can say.
//
// So the wedge has to be healed at RESOLUTION time, on whatever the chain
// produced. On the gateway path PR #6897 already re-prefixes a bare id after
// Bedrock's 400; native mode has no gateway, hence no retry — this is its
// analogue, applied before the request instead of after the failure.

function flat(providerID: string, ids: string[]): FlatModel[] {
  return ids.map((modelID) => ({
    providerID,
    providerName: providerID,
    modelID,
    modelName: modelID,
  }));
}

const BEDROCK = flat('amazon-bedrock', [
  'xai.grok-4.6',
  'global.anthropic.claude-opus-5',
  'us.anthropic.claude-opus-5',
  'anthropic.claude-opus-5',
  'openai.gpt-5.6-luna',
  'global.openai.gpt-5.6-luna',
]);

describe('healBedrockModelKey', () => {
  test('THE REGRESSION: a pinned bare id with no twin resolves to the auto-seed profile', () => {
    expect(healBedrockModelKey({ providerID: 'amazon-bedrock', modelID: 'xai.grok-4.6' }, BEDROCK)).toEqual({
      providerID: 'amazon-bedrock',
      modelID: 'global.anthropic.claude-opus-5',
    });
  });

  test('a bare id WITH a global. twin is upgraded to that twin — same model, invokable id', () => {
    expect(
      healBedrockModelKey({ providerID: 'amazon-bedrock', modelID: 'openai.gpt-5.6-luna' }, BEDROCK),
    ).toEqual({ providerID: 'amazon-bedrock', modelID: 'global.openai.gpt-5.6-luna' });
  });

  test('global. wins over a regional twin even when the regional is listed first', () => {
    const models = flat('amazon-bedrock', [
      'openai.gpt-5.6-luna',
      'us.openai.gpt-5.6-luna',
      'global.openai.gpt-5.6-luna',
    ]);
    expect(
      healBedrockModelKey({ providerID: 'amazon-bedrock', modelID: 'openai.gpt-5.6-luna' }, models),
    ).toEqual({ providerID: 'amazon-bedrock', modelID: 'global.openai.gpt-5.6-luna' });
  });

  test('a bare id with only a REGIONAL twin is upgraded to the regional profile', () => {
    const models = flat('amazon-bedrock', ['anthropic.claude-fable-5', 'us.anthropic.claude-fable-5']);
    expect(
      healBedrockModelKey({ providerID: 'amazon-bedrock', modelID: 'anthropic.claude-fable-5' }, models),
    ).toEqual({ providerID: 'amazon-bedrock', modelID: 'us.anthropic.claude-fable-5' });
  });

  test('an id that is ALREADY a profile is returned untouched (identity, no churn)', () => {
    const key = { providerID: 'amazon-bedrock', modelID: 'global.anthropic.claude-opus-5' };
    expect(healBedrockModelKey(key, BEDROCK)).toBe(key);
  });

  test('a provider serving NO profile ids is untouched — inert outside Bedrock', () => {
    const anthropic = flat('anthropic', ['claude-opus-5', 'claude-sonnet-5']);
    const key = { providerID: 'anthropic', modelID: 'claude-sonnet-5' };
    expect(healBedrockModelKey(key, anthropic)).toBe(key);
  });

  test('only the SAME provider is consulted — another provider’s profiles never leak', () => {
    const mixed = [...flat('anthropic', ['claude-opus-5']), ...BEDROCK];
    const key = { providerID: 'anthropic', modelID: 'claude-opus-5' };
    expect(healBedrockModelKey(key, mixed)).toBe(key);
  });

  test('undefined in, undefined out; an empty catalog never invents a model', () => {
    expect(healBedrockModelKey(undefined, BEDROCK)).toBeUndefined();
    const key = { providerID: 'amazon-bedrock', modelID: 'xai.grok-4.6' };
    expect(healBedrockModelKey(key, [])).toBe(key);
  });

  test('a disabled twin is never chosen — the heal respects `enabled: false`', () => {
    const models: FlatModel[] = [
      ...flat('amazon-bedrock', ['openai.gpt-5.6-luna']),
      { ...flat('amazon-bedrock', ['global.openai.gpt-5.6-luna'])[0], enabled: false },
      ...flat('amazon-bedrock', ['us.openai.gpt-5.6-luna']),
    ];
    expect(
      healBedrockModelKey({ providerID: 'amazon-bedrock', modelID: 'openai.gpt-5.6-luna' }, models),
    ).toEqual({ providerID: 'amazon-bedrock', modelID: 'us.openai.gpt-5.6-luna' });
  });

  test('the healed id preserves the key’s other fields (provider passthrough)', () => {
    const healed = healBedrockModelKey(
      { providerID: 'amazon-bedrock', modelID: 'xai.grok-4.6', provider: 'amazon-bedrock' },
      BEDROCK,
    );
    expect(healed?.provider).toBe('amazon-bedrock');
  });
});

// The end-to-end repro, on the REAL shipped catalog rather than a fixture:
// the exact Essentia setup (Bedrock bearer token + region, native path, no
// runtime yet) with the browser-global `native:` slot pinned to the bare id
// the wedged workspace left behind.
describe('the Essentia repro, against the real catalog', () => {
  test('a pinned xai.grok-4.6 resolves to an invokable inference profile', () => {
    const list = nativeProviderListFromCatalog(
      CATALOG as never,
      new Set(['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION']),
    );
    const models = flattenModels(list, { providerMode: modelProviderMode(list) });

    // What the composer's chain produced on the deployed bundle.
    const pinned = { providerID: 'amazon-bedrock', modelID: 'xai.grok-4.6' };
    expect(isOfferedModel(models, pinned)).toBe(true); // it passes validation — that is why it stuck

    const healed = healBedrockModelKey(pinned, models);
    expect(healed!.modelID).not.toBe('xai.grok-4.6');
    expect(bedrockInferenceProfileRank(healed!.modelID)).toBeGreaterThan(0);
    expect(isOfferedModel(models, healed!)).toBe(true);
    expect(healed!.modelID).toBe('global.anthropic.claude-opus-5');
  });

  test('the catalog default itself is already invokable and the heal leaves it alone', () => {
    const list = nativeProviderListFromCatalog(
      CATALOG as never,
      new Set(['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION']),
    );
    const models = flattenModels(list, { providerMode: modelProviderMode(list) });
    const seeded = (list as { default?: Record<string, string> }).default!['amazon-bedrock'];
    const key = { providerID: 'amazon-bedrock', modelID: seeded };
    expect(healBedrockModelKey(key, models)).toBe(key);
  });
});

// `use-opencode-local` has no render-test harness in this package (no
// testing-library, no renderHook anywhere in src/), so the wiring is asserted
// on the source — the same technique `use-model-connection-gate.test.ts` uses
// in apps/web. Without this, the pure guard above could pass forever while the
// hook never calls it, which is precisely the failure mode that produced this
// second round: a correct fix that the resolution chain never reached.
describe('use-opencode-local applies the guard at every resolution seam', () => {
  const source = readFileSync(join(import.meta.dir, 'use-opencode-local.ts'), 'utf8');

  test('imports the guard', () => {
    expect(source).toContain("from './bedrock-invokable'");
    expect(source).toContain('healBedrockModelKey');
  });

  test('the DISPLAYED model (currentModelKey) is healed', () => {
    const block = source.slice(
      source.indexOf('const currentModelKey'),
      source.indexOf('const onDefaultModel'),
    );
    expect(block).toContain('healBedrockModelKey');
  });

  test('the SENT model (sendModelKey) is healed — chip and request never disagree', () => {
    const block = source.slice(
      source.indexOf('const sendModelKey'),
      source.indexOf('const currentModel ='),
    );
    expect(block).toContain('healBedrockModelKey');
  });

  test("the fallback's \"first model of provider\" loop uses the auto-seedable set", () => {
    const block = source.slice(
      source.indexOf('const fallbackModel'),
      source.indexOf('const explicitModelKey'),
    );
    expect(block).toContain('autoSeedableModels');
  });
});

// ── Round 3: under the GATEWAY the heal must be inert ───────────────────────
//
// Under the gateway every served model is registered as providerID `kortix`
// and the REAL provider rides in the modelID prefix
// (`amazon-bedrock/global.anthropic.claude-opus-5`, `openrouter/z-ai/glm-5.3-flash`).
// `bedrockInferenceProfileRank` strips that prefix, so a Bedrock profile served
// through the gateway still ranks > 0 — and "the key's OWN provider", matched
// by `providerID`, is the WHOLE catalog. On the deployed Essentia bundle (web
// 39685da4, 2026-08-27) every pick without a `global.`/regional twin —
// OpenRouter GLM-5.3-Flash, Bedrock GLM-5, Codex GPT-5.6 Sol — fell through to
// step 3 and "healed" to the newest profile in the catalog, Claude Opus 5
// (Global). The chip never left Opus, and every prompt was sent with it
// (`pending_prompt.model` on the session row).
//
// The gateway already re-prefixes a bare Bedrock id after the 400 (PR #6897);
// the heal is the NATIVE analogue and has no business on a gateway key.
describe('under the gateway the heal is inert — the gateway owns bare-id retry', () => {
  const gatewayCatalog = projectLlmCatalogToProviderList({
    models: {
      'amazon-bedrock/global.anthropic.claude-opus-5': {
        name: 'Claude Opus 5 (Global)',
        provider: 'amazon-bedrock',
        released: '2026-08-01',
        enabled: true,
      },
      'amazon-bedrock/zai.glm-5': {
        name: 'GLM-5',
        provider: 'amazon-bedrock',
        released: '2026-03-01',
        enabled: true,
      },
      'openrouter/z-ai/glm-5.3-flash': {
        name: 'GLM-5.3-Flash',
        provider: 'openrouter',
        released: '2026-07-01',
        enabled: true,
      },
      'codex/gpt-5.6-sol': {
        name: 'GPT-5.6 Sol (ChatGPT)',
        provider: 'codex',
        released: '2026-06-01',
        enabled: true,
      },
    },
  } as never);
  const mode = modelProviderMode(gatewayCatalog);
  const offered = flattenModels(gatewayCatalog, { providerMode: mode });

  test('the fixture IS the gateway shape production flattens', () => {
    expect(mode).toBe('gateway');
    expect(offered.every((model) => model.providerID === 'kortix')).toBe(true);
    // The trap: a Bedrock profile served through the gateway still ranks as one.
    expect(bedrockInferenceProfileRank('amazon-bedrock/global.anthropic.claude-opus-5')).toBe(2);
  });

  test('THE REGRESSION: an OpenRouter pick is returned untouched, never the Bedrock flagship', () => {
    const key = { providerID: 'kortix', modelID: 'openrouter/z-ai/glm-5.3-flash' };
    expect(isOfferedModel(offered, key)).toBe(true);
    expect(healBedrockModelKey(key, offered)).toBe(key);
  });

  test('a bare Bedrock id under the gateway is left for the gateway to re-prefix', () => {
    const key = { providerID: 'kortix', modelID: 'amazon-bedrock/zai.glm-5' };
    expect(healBedrockModelKey(key, offered)).toBe(key);
  });

  test('a Codex pick is returned untouched', () => {
    const key = { providerID: 'kortix', modelID: 'codex/gpt-5.6-sol' };
    expect(healBedrockModelKey(key, offered)).toBe(key);
  });
});
