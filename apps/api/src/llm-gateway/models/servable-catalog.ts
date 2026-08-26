import { accountMayUseManagedModels } from '../../billing/services/entitlements';
import { listProjectSecretNamesForConsumer } from '../../projects/secrets';
import { getAccountModelDefaults } from '../../repositories/model-preferences';
import { getProjectRoutingPolicy } from '../../repositories/project-routing-policies';
import { resolveEnablement } from '../model-enablement';
import { toWireModel } from '../resolution/effective';
import { gatewayModelCatalog } from './catalog-models';
import { projectPickerCatalog } from './picker-catalog';
import { platformDefaultModelId } from './served-managed-models';

type GatewayModel = ReturnType<typeof gatewayModelCatalog>[string];

export interface ServableProjectCatalog {
  /** Wire model id → catalog record, stamped with the project's enablement. */
  models: Record<string, GatewayModel & { enabled: boolean }>;
  modelOverrides: Record<string, boolean>;
  defaultModel: string | undefined;
  usingDefaults: boolean;
}

/**
 * The ONE composition of "which models can this project actually run right
 * now": the runtime catalog reduced to managed models the account may use,
 * the providers its secrets connect, and the ids its defaults/routing name —
 * stamped with per-project enablement. Served to the web picker
 * (`GET /projects/:id/model-picker`, r4.ts) AND to the sandbox at boot
 * (`GET /v1/llm/models?scope=picker` → internal `/models` with
 * `scope:'picker'`), so the list OpenCode registers on the `kortix` provider
 * is exactly the list the composer offers. Before this the sandbox learned
 * only the managed subset and kept the image-baked org catalog for the rest:
 * a BYOK model added to models.dev after the image was built showed in the
 * picker and answered `ModelNotFound` in the runtime.
 *
 * ~80KB / ~120 models for a typical project, versus ~3.9MB / ~6.6k for the
 * full org catalog (`/llm-catalog`).
 */
export async function servableProjectCatalog(input: {
  projectId: string;
  accountId: string;
  /** Whose secret-visibility applies for the BYOK connection check; the
   *  gateway principal's user for a sandbox, the caller for the web picker. */
  principalUserId: string | null | undefined;
}): Promise<ServableProjectCatalog> {
  const { projectId, accountId, principalUserId } = input;
  const freeManagedOnly = !(await accountMayUseManagedModels(accountId));
  const [secrets, defaults, routing] = await Promise.all([
    listProjectSecretNamesForConsumer({
      projectId,
      principalUserId,
      consumer: 'llm_gateway',
    }).catch(() => [] as string[]),
    getAccountModelDefaults(accountId, projectId),
    getProjectRoutingPolicy(projectId),
  ]);
  const effectiveDefault = toWireModel(
    defaults.projects[projectId] ?? defaults.account ?? platformDefaultModelId() ?? '',
  );
  const requiredModels = [
    defaults.projects[projectId],
    defaults.account,
    platformDefaultModelId(),
    routing?.visionModel,
    ...(routing?.defaultFallback?.models ?? []),
    ...(routing?.rules.flatMap((rule) => [rule.model, ...rule.fallbackModels]) ?? []),
  ].filter((model): model is string => !!model);
  const models = projectPickerCatalog(
    gatewayModelCatalog(projectId, { freeManagedOnly }),
    new Set(secrets),
    requiredModels,
  );
  const enabled = resolveEnablement(models, routing?.modelOverrides ?? {}, requiredModels);
  return {
    models: Object.fromEntries(
      Object.entries(models).map(([id, model]) => [
        id,
        { ...model, enabled: enabled.get(id) ?? true },
      ]),
    ),
    modelOverrides: routing?.modelOverrides ?? {},
    defaultModel: effectiveDefault || undefined,
    usingDefaults: Object.keys(routing?.modelOverrides ?? {}).length === 0,
  };
}
