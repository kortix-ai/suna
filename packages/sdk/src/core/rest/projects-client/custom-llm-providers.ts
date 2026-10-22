// Custom LLM providers — a project's OpenAI-compatible endpoints, served
// through the Kortix gateway as `<id>/<model>` (BYOK, no Kortix credits).

import { backendApi } from '../../http/api-client';
import { deleteProjectSecret } from './secrets';
import { unwrap } from './shared';

/** One custom OpenAI-compatible endpoint of a project. */
export interface CustomLlmProvider {
  /** `^[a-z0-9][a-z0-9_-]{0,63}$`. Never a models.dev provider id, `kortix`, `codex` or `opencode`. */
  id: string;
  /** Display name, 1–100 characters. */
  name: string;
  /** `http(s)` URL without credentials. `null` only when `configured` is false. */
  base_url: string | null;
  /**
   * 1–50 models when configured. A model id has no whitespace. `context` and
   * `output` are the model's token limits, read from the endpoint's `GET /models`
   * on save; absent, the gateway serves a 128k window.
   */
  models: { id: string; name: string; context?: number; output?: number }[];
  /** The project secret that holds the key: `CUSTOM_<ID>_API_KEY`. */
  secret_name: string;
  /** The project-wide secret exists. The key is optional. */
  has_key: boolean;
  /** False for a `CUSTOM_*_API_KEY` secret with no endpoint saved yet. */
  configured: boolean;
}

/** The body of `PUT /projects/:id/custom-providers/:providerId`. */
export interface CustomLlmProviderInput {
  name: string;
  base_url: string;
  /** `context`/`output` override the limits the endpoint's `GET /models` reports. */
  models: { id: string; name: string; context?: number; output?: number }[];
}

/** Every custom provider of the project, legacy key-only rows included (`configured: false`). */
export async function listCustomLlmProviders(projectId: string): Promise<CustomLlmProvider[]> {
  return unwrap(await backendApi.get<{ providers: CustomLlmProvider[] }>(
      `/projects/${encodeURIComponent(projectId)}/custom-providers`,
    )).providers;
}

/** Create or replace one custom provider. Rejects with `400` `invalid_body`, `reserved_provider_id` or `unsafe_base_url`. */
export async function putCustomLlmProvider(
  projectId: string,
  providerId: string,
  input: CustomLlmProviderInput,
): Promise<CustomLlmProvider> {
  return unwrap(await backendApi.put<CustomLlmProvider>(
      `/projects/${encodeURIComponent(projectId)}/custom-providers/${encodeURIComponent(providerId)}`,
      input,
    ));
}

const isNotFound = (error: unknown) => (error as { status?: number } | null)?.status === 404;

/**
 * Delete one custom provider: its definition, then its `CUSTOM_<ID>_API_KEY`
 * project secret. A missing definition (a legacy key-only row) or a missing
 * key is not an error.
 */
export async function deleteCustomLlmProvider(projectId: string, providerId: string): Promise<void> {
  const res = await backendApi.delete(
    `/projects/${encodeURIComponent(projectId)}/custom-providers/${encodeURIComponent(providerId)}`,
    { showErrors: false },
  );
  if (!res.success && !isNotFound(res.error)) {
    throw res.error ?? new Error('Failed to delete the custom provider');
  }
  const secretName = `CUSTOM_${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`;
  await deleteProjectSecret(projectId, secretName).catch((error: unknown) => {
    if (!isNotFound(error)) throw error;
  });
}
