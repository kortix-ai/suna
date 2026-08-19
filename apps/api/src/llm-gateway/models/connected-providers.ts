import { listProjectSecretNamesForConsumer } from '../../projects/secrets';
import { connectedProviderIds } from './picker-catalog';

/**
 * The guest env var carrying this project's connected LLM providers.
 *
 * WHY THE SANDBOX NEEDS IT
 * OpenCode materializes its provider models once, at process start, from the
 * catalog baked into the sandbox image. That file is frozen at template-build
 * time while models.dev adds ~60 models a day, so a model added after the bake
 * is absent from the running provider map and every turn on it dies with
 * `ModelNotFound: kortix/<id>` (prod incident 2026-08-19 — the managed half of
 * the same defect; the BYOK half is what self-host hits, where there is no
 * managed lineup at all).
 *
 * The guest fixes that by diffing what the gateway serves against what OpenCode
 * booted with. The diff MUST be bounded to the models a user can actually pick,
 * or a day-old baked file makes it non-empty forever and every boot pays a
 * restart. `projectPickerCatalog` defines that set as
 *   managed lineup  ∪  models of the project's CONNECTED providers
 * and the connected half is not derivable inside the sandbox — it comes from
 * the project's LLM-gateway secrets, which the guest never sees. So the API
 * tells it, here.
 *
 * Value shape: comma-separated catalog provider ids, e.g. `anthropic,openrouter`.
 * Empty string = no BYOK provider connected (managed-only project).
 */
export const CONNECTED_PROVIDERS_ENV_NAME = 'KORTIX_LLM_CONNECTED_PROVIDERS';

/**
 * Resolve the connected-provider list for a project, ready to inject.
 *
 * Best-effort by design: this decides how COMPLETE the guest's model reconcile
 * is, never whether a session boots. A DB hiccup yields `''`, which degrades to
 * "managed models only" — the exact behavior that shipped before this env var
 * existed — instead of failing a provision.
 */
export async function resolveConnectedProvidersEnv(input: {
  projectId: string;
  principalUserId?: string | null;
}): Promise<string> {
  try {
    const names = await listProjectSecretNamesForConsumer({
      projectId: input.projectId,
      principalUserId: input.principalUserId ?? null,
      consumer: 'llm_gateway',
    });
    return connectedProviderIds(new Set(names)).join(',');
  } catch (err) {
    console.warn(
      `[llm-gateway] failed to resolve connected providers for project ${input.projectId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return '';
  }
}
