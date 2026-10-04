import { z } from "zod";

export const PROJECT_ROUTING_MAX_FALLBACKS = 8;
export const PROJECT_ROUTING_MAX_RULES = 20;
// A generous but finite cap — this is a per-project config document, not an
// arbitrary key-value store. Well above any real project's distinct
// configured-model count; exists only to bound the jsonb payload size.
export const PROJECT_ROUTING_MAX_GENERATION_CONFIG_MODELS = 100;

const modelId = z.string().trim().min(1).max(128).refine(
  (value) => value !== "auto" && value !== "kortix/auto",
  "fallback policies require concrete model ids",
);
const fallbackOn = z.enum(["transient", "any-error"]);

const fallback = z.object({
  models: z.array(modelId).max(PROJECT_ROUTING_MAX_FALLBACKS),
  fallbackOn,
});

const rule = z.object({
  model: modelId,
  fallbackModels: z.array(modelId).max(PROJECT_ROUTING_MAX_FALLBACKS),
  fallbackOn,
});

// Generic per-model generation-parameter defaults — deliberately loose
// (every field optional, no cross-field validation) so a new control added
// later to `@kortix/llm-catalog`'s `GenerationConfig` only needs a shape
// change here, never a migration. Capability gating/clamping (never store a
// temperature for a temperature:false model, clamp reasoning_effort to the
// model's own reasoning_options, clamp maxOutputTokens to limit.output)
// happens at the WRITE handler (gateway.ts's routing-policy PUT), which runs
// every entry through `@kortix/llm-catalog`'s `clampGenerationConfig` before
// it ever reaches this schema's caller — this schema only enforces shape and
// basic bounds, not model-aware semantics (this module doesn't have catalog
// access, and shouldn't: see project-policy.test.ts for the split).
const generationConfigEntry = z.object({
  reasoningEffort: z.string().trim().min(1).max(64).optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().min(1).max(10_000_000).optional(),
});
export type GenerationConfigEntry = z.infer<typeof generationConfigEntry>;

const generationConfig = z
  .record(modelId, generationConfigEntry)
  .refine(
    (value) => Object.keys(value).length <= PROJECT_ROUTING_MAX_GENERATION_CONFIG_MODELS,
    `at most ${PROJECT_ROUTING_MAX_GENERATION_CONFIG_MODELS} models may have a configured generation config`,
  );

export const projectRoutingPolicyInputSchema = z
  .object({
    defaultModel: modelId.nullable(),
    visionModel: modelId.nullable(),
    defaultFallback: fallback.nullable(),
    rules: z.array(rule).max(PROJECT_ROUTING_MAX_RULES),
    // Optional + defaulted so every EXISTING caller (native routing-policy
    // PUT payloads written before this field existed) keeps working
    // unchanged — additive, not a breaking schema change.
    modelGenerationConfig: generationConfig.default({}),
  })
  .superRefine((policy, ctx) => {
    const validateChain = (
      primary: string | null,
      models: string[],
      path: (string | number)[],
    ) => {
      const seen = new Set<string>();
      for (let index = 0; index < models.length; index += 1) {
        const model = models[index]!;
        if (seen.has(model)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, index],
            message: `duplicate fallback model "${model}"`,
          });
        }
        if (primary === model) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, index],
            message: `model "${primary}" cannot fall back to itself`,
          });
        }
        seen.add(model);
      }
    };

    if (policy.defaultFallback) {
      validateChain(policy.defaultModel, policy.defaultFallback.models, [
        "defaultFallback",
        "models",
      ]);
    }

    const ruleOwners = new Set<string>();
    policy.rules.forEach((item, index) => {
      if (ruleOwners.has(item.model)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rules", index, "model"],
          message: `duplicate rule for model "${item.model}"`,
        });
      }
      ruleOwners.add(item.model);
      validateChain(item.model, item.fallbackModels, [
        "rules",
        index,
        "fallbackModels",
      ]);
    });
  });

export type ProjectRoutingPolicyInput = z.infer<
  typeof projectRoutingPolicyInputSchema
>;
export type ProjectRoutingFallback = NonNullable<
  ProjectRoutingPolicyInput["defaultFallback"]
>;
export type ProjectRoutingRule = ProjectRoutingPolicyInput["rules"][number];
export type ProjectModelGenerationConfig = ProjectRoutingPolicyInput["modelGenerationConfig"];

export function parseProjectRoutingPolicyInput(
  value: unknown,
): ProjectRoutingPolicyInput {
  const parsed = projectRoutingPolicyInputSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  return parsed.data;
}
