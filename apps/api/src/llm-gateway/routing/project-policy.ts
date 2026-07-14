import { z } from "zod";

export const PROJECT_ROUTING_MAX_FALLBACKS = 8;
export const PROJECT_ROUTING_MAX_RULES = 20;

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

export const projectRoutingPolicyInputSchema = z
  .object({
    defaultModel: modelId.nullable(),
    visionModel: modelId.nullable(),
    defaultFallback: fallback.nullable(),
    rules: z.array(rule).max(PROJECT_ROUTING_MAX_RULES),
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
