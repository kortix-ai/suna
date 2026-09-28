import { z } from "zod";
import { DEFAULT_LLM_GATEWAY_FALLBACK_POLICIES, parseFallbackPolicies } from "./llm-gateway/routing/policy-config";
export const optStr = z.string().optional().default('');

/** Optional string with a custom default value. */
export const optStrDefault = (def: string) => z.string().optional().default(def);

/** Optional URL string with a custom default. Not required, just validated if present. */
export const optUrl = (def: string) =>
  z
    .string()
    .optional()
    .default(def)
    .refine((v) => v === '' || /^https?:\/\//.test(v), { message: 'Must be a valid HTTP(S) URL' });

/** Optional int with a default. */
export const optInt = (def: number) =>
  z
    .string()
    .optional()
    .default(String(def))
    .transform((v) => {
      const n = Number.parseInt(v, 10);
      return Number.isNaN(n) ? def : n;
    });

/** Optional decimal with a default — money, unlike optInt's counts. A
 *  non-numeric or negative value falls back to the default rather than
 *  silently becoming a cap of NaN (which compares false against everything and
 *  would disable the limit it was set to enforce). */
export const optNum = (def: number) =>
  z
    .string()
    .optional()
    .default(String(def))
    .transform((v) => {
      const n = Number.parseFloat(v);
      return Number.isFinite(n) && n >= 0 ? n : def;
    });

/** Optional boolean. optBoolFalse accepts the common truthy spellings
 * (case-insensitive) so a "1" / "yes" / "on" from a k8s env or secret bundle
 * isn't silently dropped. optBoolTrue keeps its original 'anything but false'
 * rule. */
export const optBoolTrue = z
  .string()
  .optional()
  .default('true')
  .transform((v) => v !== 'false');
export const optBoolFalse = z
  .string()
  .optional()
  .default('false')
  .transform((v) => ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase()));
/** Tri-state boolean: stays `undefined` when unset so a deployment-aware
 * default can be derived after parsing (see KORTIX_MANAGED_PROVIDER_ENABLED,
 * which follows the billing flag when not explicitly set). */
export const optBoolUnset = z
  .string()
  .optional()
  .transform((v) =>
    v === undefined ? undefined : ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase()),
  );

/** Declarative, operator-defined model fallback policies. */
export const optFallbackPolicies = z
  .string()
  .optional()
  .default(DEFAULT_LLM_GATEWAY_FALLBACK_POLICIES)
  .transform((raw, ctx) => {
    try {
      return parseFallbackPolicies(raw);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return z.NEVER;
  });


/**
 * Morph direct is OFF by default (2026-09-27). Its deepseek-v4.1-flash endpoint
 * ran at 78.9% uptime over 30 min on OpenRouter's public stats while our users
 * waited 18-75 s per call: the gateway fails over only on errors and a 90 s
 * header timeout, never on a slow first byte. Managed models are served by
 * their OpenRouter pool instead. Re-enable per environment by setting
 * MORPH_MANAGED_MODELS to a comma-separated list of managed model ids.
 */
export const MORPH_MANAGED_MODELS_DEFAULT = '';

export function parseMorphManagedModels(value: string): string[] {
  return value.split(',').map((id) => id.trim()).filter(Boolean);
}
