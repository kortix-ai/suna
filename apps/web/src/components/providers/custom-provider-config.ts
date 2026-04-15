import type { Config } from '@opencode-ai/sdk/v2/client';

export interface CustomProviderFormValues {
  providerID: string;
  name: string;
  baseURL: string;
  apiKey: string;
  modelId: string;
  modelName: string;
}

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
  const normalized = normalizeCustomProviderForm(form);

  if (!normalized.providerID || !normalized.name || !normalized.baseURL) {
    return 'Provider ID, name, and base URL are required';
  }

  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(normalized.providerID)) {
    return 'Provider ID can only use letters, numbers, dashes, and underscores';
  }

  if (!normalized.modelId || !normalized.modelName) {
    return 'At least one model (ID + name) is required';
  }

  if (!/^https?:\/\//.test(normalized.baseURL)) {
    return 'Base URL must start with http:// or https://';
  }

  return null;
}

export function isEnvReference(value: string): boolean {
  return /^\{env:[A-Z0-9_]+\}$/i.test(value.trim());
}

export function buildCustomProviderConfigUpdate(
  existingConfig: Partial<Config> | undefined,
  form: CustomProviderFormValues,
): Partial<Config> {
  const normalized = normalizeCustomProviderForm(form);
  const existingProviders =
    existingConfig?.provider && typeof existingConfig.provider === 'object'
      ? existingConfig.provider
      : {};

  const options: Record<string, string> = {
    baseURL: normalized.baseURL,
  };

  if (normalized.apiKey && isEnvReference(normalized.apiKey)) {
    options.apiKey = normalized.apiKey;
  }

  return {
    provider: {
      ...existingProviders,
      [normalized.providerID]: {
        npm: '@ai-sdk/openai-compatible',
        name: normalized.name,
        options,
        models: {
          [normalized.modelId]: {
            id: normalized.modelId,
            name: normalized.modelName,
            family: normalized.providerID,
          },
        },
      },
    },
  };
}
