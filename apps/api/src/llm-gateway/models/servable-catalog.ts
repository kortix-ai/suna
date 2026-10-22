import { getProjectGatewayResolution } from '../../repositories/project-model-access';
import { modelAccessAllows } from '../model-access';
import { accountMayUseManagedModels } from '../../billing/services/entitlements';
import { getProjectSecretValueForConsumer, listProjectSecretNamesForConsumer } from '../../projects/secrets';
import { getAccountModelDefaults } from '../../repositories/model-preferences';
import { getProjectRoutingPolicy } from '../../repositories/project-routing-policies';
import { resolveEnablement } from '../model-enablement';
import { toWireModel } from '../resolution/effective';
import { gatewayModelCatalog } from './catalog-models';
import { projectPickerCatalog, type UnavailableModelMark } from './picker-catalog';
import { platformDefaultModelId } from './served-managed-models';
import { projectFeatureFlagEnabled } from '../../feature-flags/for-project';
import { listGrantedGatewaySecretNames } from '../../secrets/account-resource';
import { customProviderCatalog } from '../custom-providers';
import { PLATINUM_PROVIDER } from '@kortix/llm-catalog';
import { platinumByokCatalog } from './platinum-byok-models';

type GatewayModel = ReturnType<typeof gatewayModelCatalog>[string];

export interface ServableProjectCatalog {
  /** Wire model id → catalog record, stamped with the project's enablement,
   *  and `available: false` when only a default names it and its provider is
   *  not connected for the caller. */
  models: Record<string, GatewayModel & { enabled: boolean } & Partial<UnavailableModelMark>>;
  modelOverrides: Record<string, boolean>;
  defaultModel: string | undefined;
  usingDefaults: boolean;
}

/**
 * The ONE composition of "which models can this project actually run right
 * now": the runtime catalog reduced to managed models the account may use,
 * the providers its secrets connect, the project's custom providers, and the
 * ids its defaults/routing name —
 * stamped with per-project enablement. Served to the web picker
 * (`GET /projects/:id/model-picker`, routes/models.ts) AND to the sandbox at boot
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
  /** The member whose project access admits keys shared with the whole
   *  project: the gateway principal's user for a sandbox, the caller for the
   *  web picker, the linked person for a chat channel. */
  principalUserId: string | null | undefined;
  /**
   * Whose PERSONAL resources count — a personal project-secret override and
   * a pooled key granted to one member. Absent = `principalUserId`. `null` =
   * none: a shared session reaches only project-wide keys (spec 2026-09-22
   * §2.3). Before this was separate, a shared session got NO pooled key at
   * all, so a model reached through a project-wide key was missing from the
   * list its sandbox registers.
   */
  personalUserId?: string | null;
}): Promise<ServableProjectCatalog> {
  const { projectId, accountId, principalUserId } = input;
  const personalUserId = input.personalUserId === undefined ? (principalUserId ?? null) : input.personalUserId;
  const freeManagedOnly = !(await accountMayUseManagedModels(accountId));
  const [secrets, defaults, routing, resolution, pooledEnabled] = await Promise.all([
    listProjectSecretNamesForConsumer({
      projectId,
      principalUserId: personalUserId,
      consumer: 'llm_gateway',
    }).catch(() => [] as string[]),
    getAccountModelDefaults(accountId, projectId),
    getProjectRoutingPolicy(projectId),
    getProjectGatewayResolution(projectId),
    projectFeatureFlagEnabled(projectId, 'pooled_provider_secrets'),
  ]);
  const pooledNames = pooledEnabled && principalUserId
    ? await listGrantedGatewaySecretNames(accountId, projectId, principalUserId, personalUserId).catch(() => [] as string[])
    : [];
  // An account without managed models has no platform default.
  const platformDefault = freeManagedOnly ? undefined : platformDefaultModelId();
  const effectiveDefault = toWireModel(
    defaults.projects[projectId] ?? defaults.account ?? platformDefault ?? '',
  );
  const requiredModels = [
    defaults.projects[projectId],
    defaults.account,
    platformDefault,
    routing?.visionModel,
    ...(routing?.defaultFallback?.models ?? []),
    ...(routing?.rules.flatMap((rule) => [rule.model, ...rule.fallbackModels]) ?? []),
  ].filter((model): model is string => !!model);
  const { access } = resolution;
  // A custom endpoint is servable once defined (its key is optional) and on by
  // default: it has no release date or family for the recency rule to rank.
  const custom = customProviderCatalog(resolution.customProviders ?? []);
  // Platinum (BYOK): its models are whatever Platinum lists for the project's
  // own key, on by default like a custom endpoint (no release date to rank).
  const platinumKeyName = PLATINUM_PROVIDER.env![0]!;
  const platinum = secrets.includes(platinumKeyName)
    ? await platinumByokCatalog(await getProjectSecretValueForConsumer({
      projectId, accountId, principalUserId: personalUserId, actorUserId: principalUserId,
      name: platinumKeyName, consumer: 'llm_gateway', probe: true,
    }).catch(() => null))
    : {};
  const models = {
    ...projectPickerCatalog(
      gatewayModelCatalog(projectId, { freeManagedOnly }),
      new Set([...secrets, ...pooledNames]),
      requiredModels,
    ),
    ...platinum,
    ...custom,
  };
  const enabled = resolveEnablement(models, routing?.modelOverrides ?? {},
    [...requiredModels, ...Object.keys(platinum), ...Object.keys(custom)]);
  return {
    models: Object.fromEntries(
      Object.entries(models).map(([id, model]) => [
        id,
        { ...model, enabled: modelAccessAllows(access, id) && (enabled.get(id) ?? true) },
      ]),
    ),
    modelOverrides: routing?.modelOverrides ?? {},
    defaultModel: effectiveDefault || undefined,
    usingDefaults: Object.keys(routing?.modelOverrides ?? {}).length === 0,
  };
}
