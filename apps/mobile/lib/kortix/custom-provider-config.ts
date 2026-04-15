/**
 * Custom provider configuration utilities.
 * Ported from web's apps/web/src/components/providers/custom-provider-config.ts (0a31da4).
 *
 * Pure functions — no React or RN dependencies.
 */

export interface CustomProviderFormValues {
  providerID: string;
  name: string;
  baseURL: string;
  apiKey: string;
  modelId: string;
  modelName: string;
}

export const EMPTY_CUSTOM_FORM: CustomProviderFormValues = {
  providerID: '',
  name: '',
  baseURL: '',
  apiKey: '',
  modelId: '',
  modelName: '',
};

export function normalizeCustomProviderForm(
  form: CustomProviderFormValues,
): CustomProviderFormValues {
  return {
    providerID: form.providerID.trim(),
    name: form.name.trim(),
    baseURL: form.baseURL.trim(),
    apiKey: form.apiKey.trim(),
    modelId: form.modelId.trim(),
    modelName: form.modelName.trim(),
  };
}

export function validateCustomProviderForm(
  form: CustomProviderFormValues,
): string | null {
  const n = normalizeCustomProviderForm(form);

  if (!n.providerID || !n.name || !n.baseURL) {
    return 'Provider ID, name, and base URL are required';
  }

  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(n.providerID)) {
    return 'Provider ID can only use letters, numbers, dashes, and underscores';
  }

  if (!n.modelId || !n.modelName) {
    return 'Model ID and model name are required';
  }

  if (!/^https?:\/\//.test(n.baseURL)) {
    return 'Base URL must start with http:// or https://';
  }

  return null;
}

export function isEnvReference(value: string): boolean {
  return /^\{env:[A-Z0-9_]+\}$/i.test(value.trim());
}

/**
 * Build a config update object that registers a custom OpenAI-compatible
 * provider. Merges with any existing providers in the config so nothing
 * is overwritten.
 */
export function buildCustomProviderConfigUpdate(
  existingConfig: Record<string, any> | undefined,
  form: CustomProviderFormValues,
): Record<string, any> {
  const n = normalizeCustomProviderForm(form);
  const existingProviders =
    existingConfig?.provider && typeof existingConfig.provider === 'object'
      ? existingConfig.provider
      : {};

  const options: Record<string, string> = {
    baseURL: n.baseURL,
  };

  // If the key is an env reference, store it in config (not in auth)
  if (n.apiKey && isEnvReference(n.apiKey)) {
    options.apiKey = n.apiKey;
  }

  return {
    provider: {
      ...existingProviders,
      [n.providerID]: {
        npm: '@ai-sdk/openai-compatible',
        name: n.name,
        options,
        models: {
          [n.modelId]: {
            id: n.modelId,
            name: n.modelName,
            family: n.providerID,
          },
        },
      },
    },
  };
}
