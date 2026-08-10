import { describe, expect, test } from "bun:test";

import { parseWorkspaceRoutingPolicyInput } from './workspace-policy';

const valid = {
  defaultModel: "codex/gpt-5.6-sol",
  visionModel: null,
  defaultFallback: { models: ["glm-5.2"], fallbackOn: "any-error" as const },
  rules: [
    {
      model: "anthropic/claude-opus-4.8",
      fallbackModels: ["anthropic/claude-sonnet-4.6"],
      fallbackOn: "transient" as const,
    },
  ],
  modelGenerationConfig: {},
};

describe("workspace gateway routing policy input", () => {
  test("accepts inherited values, an explicitly disabled default chain, and exact rules", () => {
    expect(parseWorkspaceRoutingPolicyInput(valid)).toEqual(valid);
    expect(
      parseWorkspaceRoutingPolicyInput({
        defaultModel: null,
        visionModel: null,
        defaultFallback: null,
        rules: [],
      }),
    ).toEqual({
      defaultModel: null,
      visionModel: null,
      defaultFallback: null,
      rules: [],
      modelGenerationConfig: {},
    });
    expect(
      parseWorkspaceRoutingPolicyInput({
        ...valid,
        defaultFallback: { models: [], fallbackOn: "transient" },
      }).defaultFallback?.models,
    ).toEqual([]);
  });

  test("rejects duplicate exact models, duplicate chain entries, and self loops", () => {
    expect(() =>
      parseWorkspaceRoutingPolicyInput({
        ...valid,
        rules: [valid.rules[0], valid.rules[0]],
      }),
    ).toThrow("duplicate rule");
    expect(() =>
      parseWorkspaceRoutingPolicyInput({
        ...valid,
        defaultFallback: {
          models: ["glm-5.2", "glm-5.2"],
          fallbackOn: "any-error",
        },
      }),
    ).toThrow("duplicate fallback");
    expect(() =>
      parseWorkspaceRoutingPolicyInput({
        ...valid,
        rules: [
          {
            model: "same/model",
            fallbackModels: ["same/model"],
            fallbackOn: "any-error",
          },
        ],
      }),
    ).toThrow("cannot fall back to itself");
  });

  test("enforces the finite 8-model / 20-rule bounds", () => {
    expect(() =>
      parseWorkspaceRoutingPolicyInput({
        ...valid,
        defaultFallback: {
          models: Array.from(
            { length: 9 },
            (_, index) => `vendor/model-${index}`,
          ),
          fallbackOn: "transient",
        },
      }),
    ).toThrow();
    expect(() =>
      parseWorkspaceRoutingPolicyInput({
        ...valid,
        rules: Array.from({ length: 21 }, (_, index) => ({
          model: `vendor/primary-${index}`,
          fallbackModels: [],
          fallbackOn: "transient" as const,
        })),
      }),
    ).toThrow();
  });

  test("rejects the synthetic auto model inside a concrete route", () => {
    expect(() => parseWorkspaceRoutingPolicyInput({
      ...valid,
      defaultFallback: { models: ["auto"], fallbackOn: "any-error" },
    })).toThrow("concrete model ids");
  });

  test("modelGenerationConfig defaults to {} when omitted (back-compat with pre-existing payloads)", () => {
    const { defaultModel, visionModel, defaultFallback, rules } = valid;
    const parsed = parseWorkspaceRoutingPolicyInput({
      defaultModel,
      visionModel,
      defaultFallback,
      rules,
    });
    expect(parsed.modelGenerationConfig).toEqual({});
  });

  test("accepts a per-model generation config keyed by wire model id", () => {
    const parsed = parseWorkspaceRoutingPolicyInput({
      ...valid,
      modelGenerationConfig: {
        "openai/gpt-5.6-sol": { reasoningEffort: "high", maxOutputTokens: 4096 },
      },
    });
    expect(parsed.modelGenerationConfig).toEqual({
      "openai/gpt-5.6-sol": { reasoningEffort: "high", maxOutputTokens: 4096 },
    });
  });

  test("rejects an out-of-range temperature/top_p in a generation config entry", () => {
    expect(() =>
      parseWorkspaceRoutingPolicyInput({
        ...valid,
        modelGenerationConfig: { "openai/gpt-4.1": { temperature: 3 } },
      }),
    ).toThrow();
    expect(() =>
      parseWorkspaceRoutingPolicyInput({
        ...valid,
        modelGenerationConfig: { "openai/gpt-4.1": { topP: -1 } },
      }),
    ).toThrow();
  });

  test("caps the number of models a generation config may cover", () => {
    const modelGenerationConfig = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`vendor/model-${index}`, { temperature: 0.5 }]),
    );
    expect(() =>
      parseWorkspaceRoutingPolicyInput({ ...valid, modelGenerationConfig }),
    ).toThrow();
  });
});
