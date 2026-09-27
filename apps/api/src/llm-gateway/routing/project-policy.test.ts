import { describe, expect, test } from "bun:test";

import { parseProjectRoutingPolicyInput } from "./project-policy";

const valid = {
  defaultModel: "codex/gpt-5.6-sol",
  visionModel: null,
  defaultFallback: { models: ["glm-5.3-flash"], fallbackOn: "any-error" as const },
  rules: [
    {
      model: "anthropic/claude-opus-4.8",
      fallbackModels: ["anthropic/claude-sonnet-4.6"],
      fallbackOn: "transient" as const,
    },
  ],
  modelGenerationConfig: {},
};

describe("project gateway routing policy input", () => {
  test("accepts inherited values, an explicitly disabled default chain, and exact rules", () => {
    expect(parseProjectRoutingPolicyInput(valid)).toEqual(valid);
    expect(
      parseProjectRoutingPolicyInput({
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
      parseProjectRoutingPolicyInput({
        ...valid,
        defaultFallback: { models: [], fallbackOn: "transient" },
      }).defaultFallback?.models,
    ).toEqual([]);
    // A per-model generation config is keyed by wire model id and kept as given.
    expect(
      parseProjectRoutingPolicyInput({
        ...valid,
        modelGenerationConfig: {
          "openai/gpt-5.6-sol": { reasoningEffort: "high", maxOutputTokens: 4096 },
        },
      }).modelGenerationConfig,
    ).toEqual({
      "openai/gpt-5.6-sol": { reasoningEffort: "high", maxOutputTokens: 4096 },
    });
  });

  test("rejects duplicate exact models, duplicate chain entries, and self loops", () => {
    expect(() =>
      parseProjectRoutingPolicyInput({
        ...valid,
        rules: [valid.rules[0], valid.rules[0]],
      }),
    ).toThrow("duplicate rule");
    expect(() =>
      parseProjectRoutingPolicyInput({
        ...valid,
        defaultFallback: {
          models: ["glm-5.3-flash", "glm-5.3-flash"],
          fallbackOn: "any-error",
        },
      }),
    ).toThrow("duplicate fallback");
    expect(() =>
      parseProjectRoutingPolicyInput({
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

  const fallbacks = (length: number) => ({
    ...valid,
    defaultFallback: {
      models: Array.from({ length }, (_, index) => `vendor/model-${index}`),
      fallbackOn: "transient" as const,
    },
  });
  const rules = (length: number) => ({
    ...valid,
    rules: Array.from({ length }, (_, index) => ({
      model: `vendor/primary-${index}`,
      fallbackModels: [],
      fallbackOn: "transient" as const,
    })),
  });

  test("accepts exactly 8 fallback models and 20 rules", () => {
    expect(parseProjectRoutingPolicyInput(fallbacks(8)).defaultFallback?.models).toHaveLength(8);
    expect(parseProjectRoutingPolicyInput(rules(20)).rules).toHaveLength(20);
  });

  test("rejects 9 fallback models and 21 rules", () => {
    expect(() => parseProjectRoutingPolicyInput(fallbacks(9))).toThrow();
    expect(() => parseProjectRoutingPolicyInput(rules(21))).toThrow();
  });

  test.each(["auto", "kortix/auto"])("rejects the synthetic %s model inside a concrete route", (model) => {
    expect(() => parseProjectRoutingPolicyInput({
      ...valid,
      defaultFallback: { models: [model], fallbackOn: "any-error" },
    })).toThrow("concrete model ids");
  });

  test("rejects an out-of-range temperature/top_p in a generation config entry", () => {
    expect(() =>
      parseProjectRoutingPolicyInput({
        ...valid,
        modelGenerationConfig: { "openai/gpt-4.1": { temperature: 3 } },
      }),
    ).toThrow();
    expect(() =>
      parseProjectRoutingPolicyInput({
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
      parseProjectRoutingPolicyInput({ ...valid, modelGenerationConfig }),
    ).toThrow();
  });
});
