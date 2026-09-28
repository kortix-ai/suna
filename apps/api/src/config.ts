import { hydrateEnvironmentSecret } from "@kortix/shared";
import { validateEnv } from "./validate-env";
import { buildConfig } from "./config-values";

hydrateEnvironmentSecret();

export { MORPH_MANAGED_MODELS_DEFAULT, parseMorphManagedModels } from "./env-schema-helpers";
export { KNOWN_PROVIDERS, parseAllowedProviders } from "./providers-config";
export type { SandboxProviderName } from "./providers-config";
export { KORTIX_MARKUP, getToolCost } from "./tool-pricing";

export const SANDBOX_VERSION = process.env.SANDBOX_VERSION || "unknown";
export const config = buildConfig(validateEnv());
