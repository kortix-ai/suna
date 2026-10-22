import type { ManagedModel } from '../../llm-gateway/models/managed-models';

/** A Platinum `/models` answer, as the live endpoint shapes it (test data). */
export const PLATINUM_MODELS_RESPONSE = {
  object: 'list',
  data: [
    {
      id: 'deepseek-v4.1-flash', object: 'model', owned_by: 'platinum', name: 'DeepSeek V4.1 Flash',
      context_length: 1_000_000, max_output_tokens: 65_536,
      modalities: { input: ['text', 'image'], output: ['text'] }, capabilities: { tools: true, reasoning: true },
      reasoning_efforts: ['none', 'low', 'high', 'max'],
      pricing: { input: 0.15, cached_input: 0.003, output: 0.6 },
    },
    {
      id: 'glm-5.3-flash', object: 'model', owned_by: 'platinum', name: 'GLM 5.3 Flash',
      context_length: 1_000_000, max_output_tokens: 65_536,
      modalities: { input: ['text', 'image'], output: ['text'] }, capabilities: { tools: true, reasoning: true },
      reasoning_efforts: ['low', 'high', 'max'],
      pricing: { input: 0.1, cached_input: 0.02, output: 0.35 },
    },
  ],
};

/** The lineup `PLATINUM_MODELS_RESPONSE` maps to. */
export const TEST_MANAGED_LINEUP: ManagedModel[] = [
  {
    id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash',
    pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6, cachedInputPerMillion: 0.003 },
    vision: true, reasoningOptions: [{ type: 'effort', values: ['none', 'low', 'high', 'max'] }],
    limit: { context: 1_000_000, output: 65_536 },
  },
  {
    id: 'glm-5.3-flash', name: 'GLM 5.3 Flash',
    pricing: { inputPerMillion: 0.1, outputPerMillion: 0.35, cachedInputPerMillion: 0.02 },
    vision: true, reasoningOptions: [{ type: 'effort', values: ['low', 'high', 'max'] }],
    limit: { context: 1_000_000, output: 65_536 },
  },
];
