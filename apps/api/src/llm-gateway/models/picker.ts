import { listProjectSecretsSnapshot } from '../../projects/secrets';
import { resolveEffectiveModel } from '../resolution/default-model';
import type { ModelSource } from '../resolution/effective';
import {
  type PickerModel,
  connectedByokPickerModels,
  labelForModelRef,
  managedPickerModels,
} from './picker-catalog';

// The REAL served-model source for compact pickers (Slack, and any curated web
// surface). Built from the gateway's actual catalog — managed Kortix models +
// the project's CONNECTED BYOK providers — never a hand-maintained list. The
// previous Slack picker offered four hardcoded ids that didn't match the served
// catalog (wrong `anthropic/` prefix, dashed vs dotted versions, models that
// aren't served), so every pick risked a gateway 404 ("model isn't available").

export type { PickerModel } from './picker-catalog';
export { labelForModelRef, providerFlagship } from './picker-catalog';

/**
 * The picker's model list for a project: managed models (unless the account is
 * free-tier-managed-only) + the flagship of each CONNECTED BYOK provider, plus
 * the resolved project default (what a session uses with no per-channel/session
 * override) so a surface can offer "Use project default (X)".
 */
export async function listPickerModels(params: {
  projectId: string;
  userId: string;
  accountId: string;
  freeManagedOnly: boolean;
  agentName?: string | null;
}): Promise<{
  models: PickerModel[];
  projectDefault: { model: string | null; source: ModelSource; label: string | null };
}> {
  const models: PickerModel[] = params.freeManagedOnly ? [] : managedPickerModels();

  // CONNECTED BYOK providers: a provider whose first env var is a saved
  // project-wide secret. We match against the project-wide snapshot because that
  // is exactly what request-time resolution (resolveCandidates → project-wide
  // getProjectSecretValue) keys off — so the picker and servability agree.
  try {
    const snapshot = await listProjectSecretsSnapshot(params.projectId);
    const connected = new Set(snapshot.names.map((n) => n.toUpperCase()));
    models.push(...connectedByokPickerModels(connected));
  } catch {
    // Secret read failed — fall back to managed-only rather than erroring the picker.
  }

  const effective = await resolveEffectiveModel({
    userId: params.userId,
    accountId: params.accountId,
    projectId: params.projectId,
    agentName: params.agentName,
    explicit: null,
    freeModelsOnly: params.freeManagedOnly,
  });

  return {
    models,
    projectDefault: {
      model: effective.model,
      source: effective.source,
      label: effective.model ? labelForModelRef(effective.model) : null,
    },
  };
}
