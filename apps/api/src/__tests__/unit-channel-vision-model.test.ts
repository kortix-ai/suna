import { describe, expect, mock, test } from 'bun:test';
import { capabilityReadsImages, channelTurnModel, promptModelOverride } from '../channels/vision-model';

/**
 * Why this exists: on dev 2026-09-19 a Teams message with a pasted screenshot
 * ran on `deepseek-v4-flash`. The agent downloaded the PNG (28 740 bytes,
 * verified), called `read`, saw nothing, went looking for ImageMagick and
 * tesseract, and ended the turn with no answer. The retry on 2026-09-21 then
 * failed a second way, which the first two blocks below pin down.
 */

/**
 * The flag that matters. `glm-5.3-flash` ships `attachment: true` with
 * text-only modalities — the managed catalog sets `vision: true` by hand while
 * its models.dev record carries no image modality — and OpenCode honours the
 * modalities. Selecting on `attachment` routed a Teams image turn to it and
 * the agent answered "the model I'm running on right now can't process images".
 */
describe('capabilityReadsImages', () => {
  test('modalities win over a hand-set attachment flag', () => {
    expect(capabilityReadsImages({ attachment: true, modalities: { input: ['text'] } })).toBe(false);
  });

  test('an image modality is the yes', () => {
    expect(capabilityReadsImages({ attachment: true, modalities: { input: ['text', 'image'] } })).toBe(true);
  });

  test('attachment is the fallback only when nothing publishes modalities', () => {
    expect(capabilityReadsImages({ attachment: true })).toBe(true);
    expect(capabilityReadsImages({ attachment: false })).toBe(false);
    expect(capabilityReadsImages({ attachment: true, modalities: {} })).toBe(true);
  });

  test('an unknown model never claims vision', () => {
    expect(capabilityReadsImages(undefined)).toBe(false);
  });
});

/**
 * Every served model is registered under the ONE synthetic `kortix` OpenCode
 * provider, so a slash belongs to the model id. Splitting it addresses a
 * provider the runtime has never heard of, the override is dropped without a
 * word, and the turn quietly runs on the text-only model again — which would
 * break exactly the `codex/*` models that can read images.
 */
describe('promptModelOverride', () => {
  test('a managed slug is addressed on the kortix provider', () => {
    expect(promptModelOverride('glm-5.3-flash')).toEqual({
      providerID: 'kortix',
      modelID: 'glm-5.3-flash',
    });
  });

  test('a codex id stays whole on the kortix provider', () => {
    expect(promptModelOverride('codex/gpt-6-astra')).toEqual({
      providerID: 'kortix',
      modelID: 'codex/gpt-6-astra',
    });
  });

  test('a BYOK ref keeps every slash in the model id', () => {
    expect(promptModelOverride('openrouter/z-ai/glm-5.3')).toEqual({
      providerID: 'kortix',
      modelID: 'openrouter/z-ai/glm-5.3',
    });
  });

  test('only a leading kortix/ is stripped', () => {
    expect(promptModelOverride('kortix/codex/gpt-6-astra')).toEqual({
      providerID: 'kortix',
      modelID: 'codex/gpt-6-astra',
    });
  });
});

/**
 * The second way a channel turn is dead before it starts: the session's pin
 * was retired from the catalog. Verified on dev 2026-09-21 —
 * `PUT /sessions/:id/model` answered
 * `Model "deepseek-v4-flash" is not available for this account` for the model
 * that Teams session had been pinned to since 2026-09-18, so every turn would
 * have failed upstream with nothing shown to the user.
 *
 * The configured vision target is mocked as `gpt-5.6-luna`, which dev refuses,
 * so these also prove the fall-through: a target that is not servable must
 * never be pinned onto the prompt.
 */
describe('channelTurnModel', () => {
  const base = { projectId: 'p1', accountId: 'a1', userId: 'u1' };

  test('leaves a healthy pin alone when the message has no image', async () => {
    expect(await channelTurnModel({ ...base, currentModel: 'codex/gpt-6-astra', hasImage: false })).toBeNull();
  });

  test('leaves a vision-capable pin alone even when the message has an image', async () => {
    expect(await channelTurnModel({ ...base, currentModel: 'codex/gpt-6-astra', hasImage: true })).toBeNull();
  });

  test('a text-only pin with an image moves to a model that really reads images', async () => {
    expect(await channelTurnModel({ ...base, currentModel: 'deepseek-v4-flash', hasImage: true })).toBe(
      'codex/gpt-6-astra',
    );
  });

  test('the unservable configured target is skipped, not pinned', async () => {
    expect(await channelTurnModel({ ...base, currentModel: 'deepseek-v4-flash', hasImage: true })).not.toBe(
      'gpt-5.6-luna',
    );
  });

  test('glm-5.3-flash is never chosen for an image despite attachment: true', async () => {
    expect(await channelTurnModel({ ...base, currentModel: 'deepseek-v4-flash', hasImage: true })).not.toBe(
      'glm-5.3-flash',
    );
  });

  test('replaces a retired pin with the platform default when no image is involved', async () => {
    expect(await channelTurnModel({ ...base, currentModel: 'retired-model-v1', hasImage: false })).toBe(
      'deepseek-v4-flash',
    );
  });

  test('a retired pin AND an image must land on a model that can read one', async () => {
    expect(await channelTurnModel({ ...base, currentModel: 'retired-model-v1', hasImage: true })).toBe(
      'codex/gpt-6-astra',
    );
  });

  test('an unauthenticated sender never moves the model', async () => {
    expect(
      await channelTurnModel({ ...base, userId: null, currentModel: 'retired-model-v1', hasImage: true }),
    ).toBeNull();
  });
});

mock.module('../config', () => ({
  config: { LLM_GATEWAY_VISION_MODEL: 'gpt-5.6-luna' },
}));

mock.module('../llm-gateway/models/served-managed-models', () => ({
  platformDefaultModelId: () => 'deepseek-v4-flash',
}));

mock.module('../llm-gateway/enablement', () => ({
  projectLlmGatewayEnabledById: async () => true,
}));

mock.module('../billing/services/entitlements', () => ({
  accountMayUseManagedModels: async () => true,
}));

// Mirrors dev: the configured vision target is refused, the rest are not.
mock.module('../llm-gateway/resolution/default-model', () => ({
  isModelServableForAccount: async ({ model }: { model: string }) =>
    model !== 'gpt-5.6-luna' && model !== 'retired-model-v1',
}));

const CATALOG = {
  'deepseek-v4-flash': {
    name: 'DeepSeek V4 Flash',
    attachment: false,
    modalities: { input: ['text'] },
    cost: { input: 0.09 },
  },
  // Exactly the dev shape: hand-set vision, text-only modalities.
  'glm-5.3-flash': {
    name: 'GLM 5.3 Flash',
    attachment: true,
    modalities: { input: ['text'] },
    cost: { input: 0.075 },
  },
  'codex/gpt-6-astra': {
    name: 'GPT-6 Astra',
    attachment: true,
    modalities: { input: ['text', 'image'] },
    cost: { input: 1.25 },
  },
};

mock.module('../llm-gateway/models/catalog-models', () => ({
  gatewayModelCatalog: () => CATALOG,
}));

mock.module('../llm-gateway/models/servable-catalog', () => ({
  servableProjectCatalog: async () => ({
    models: Object.fromEntries(Object.entries(CATALOG).map(([k, v]) => [k, { ...v, enabled: true }])),
    modelOverrides: {},
    defaultModel: 'deepseek-v4-flash',
    usingDefaults: true,
  }),
}));
