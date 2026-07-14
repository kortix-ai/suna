import { describe, expect, test } from "bun:test";

import { parseProjectRoutingPolicyInput } from "./project-policy";

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
    });
    expect(
      parseProjectRoutingPolicyInput({
        ...valid,
        defaultFallback: { models: [], fallbackOn: "transient" },
      }).defaultFallback?.models,
    ).toEqual([]);
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
          models: ["glm-5.2", "glm-5.2"],
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

  test("enforces the finite 8-model / 20-rule bounds", () => {
    expect(() =>
      parseProjectRoutingPolicyInput({
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
      parseProjectRoutingPolicyInput({
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
    expect(() => parseProjectRoutingPolicyInput({
      ...valid,
      defaultFallback: { models: ["auto"], fallbackOn: "any-error" },
    })).toThrow("concrete model ids");
  });
});
