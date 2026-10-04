import { type Catalog, type CatalogModel, autoSeedDefaultModel } from '@kortix/llm-catalog';
import { toWireModel } from '../resolution/effective';
import { resolveCatalogUpstream } from './provider-registry';
import { runtimeModelCatalog } from './runtime-catalog';
import { RUNTIME_MANAGED_MODELS } from './managed-models';
import { SERVED_MANAGED_MODELS } from './served-managed-models';

// PURE catalog logic for the model picker — no DB, no config, so it's unit-
// testable in isolation. The DB-touching assembly (connected BYOK providers +
// resolved project default) lives in picker.ts and builds on these.

export interface PickerModel {
  /** Opencode model ref — `kortix/<id>` for managed, `provider/model` for BYOK. */
  id: string;
  /** Human label, e.g. "Claude Opus 4.8". */
  label: string;
  /** 'kortix' for managed, else the catalog provider id. */
  provider: string;
  /** True for platform-managed (credits-billed) models. */
  managed: boolean;
  /** Short note, e.g. "Most capable" or "Anthropic". */
  hint?: string;
}

interface PickerCatalogState {
  revision: number;
  catalog: Catalog;
  modelById: Map<string, CatalogModel>;
}

let cachedState: PickerCatalogState | null = null;

function catalogState(): PickerCatalogState {
  const revision = runtimeModelCatalog.status().revision;
  if (cachedState?.revision === revision) return cachedState;
  const catalog = runtimeModelCatalog.snapshot();
  const modelById = new Map<string, CatalogModel>();
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      modelById.set(`${provider.id}/${model.id}`, model);
    }
  }
  cachedState = { revision, catalog, modelById };
  return cachedState;
}

/** The flagship BYOK model id (bare, no provider prefix) for a provider, or null. */
export function providerFlagship(providerId: string): string | null {
  const state = catalogState();
  // The newest AUTO-SELECTABLE model the live catalog carries for this
  // provider — no curated per-provider list: one went stale within a week of
  // every launch (gpt-5.5 / claude-opus-4-8 after gpt-6.1-sol and claude-sonnet-5-5
  // shipped). `autoSeedDefaultModel` skips deprecated/beta. Released dates sort lexically
  // (YYYY-MM-DD); `autoSeedDefaultModel` additionally drops the bare Bedrock
  // ids whenever the provider serves inference profiles. A tie-break alone was
  // not enough: `xai.grok-4.6` is the NEWEST Bedrock model and has no
  // `global.`/`us.` twin to tie with, so it won outright and a fresh BYOK
  // Bedrock project was seeded with `amazon-bedrock/xai.grok-4.6` — which
  // Bedrock refuses ("on-demand throughput isn't supported").
  const provider = state.catalog.providers.find((p) => p.id === providerId);
  if (!provider || provider.models.length === 0) return null;
  return autoSeedDefaultModel(provider.models)?.id ?? null;
}

/** Whether a provider exposes a BYOK upstream and is connected for `connectedEnvVars`. */
export function isProviderConnected(providerId: string, connectedEnvVars: Set<string>): boolean {
  const upstream = resolveCatalogUpstream(providerId);
  return !!upstream && connectedEnvVars.has(upstream.envVar.toUpperCase());
}

/**
 * Reduce the gateway's runtime catalog to the models a project can actually
 * choose without downloading the complete models.dev registry. Managed models
 * are always retained (the caller has already applied free-tier filtering),
 * connected BYOK/Codex providers retain their served models, and configured
 * models are kept so existing defaults and fallback policies remain editable
 * after a provider is disconnected.
 */
export function projectPickerCatalog<T>(
  fullCatalog: Record<string, T>,
  connectedEnvVars: Set<string>,
  requiredModels: string[],
): Record<string, T> {
  const required = new Set(requiredModels.filter(Boolean).map(toWireModel));
  const codexConnected =
    connectedEnvVars.has('CODEX_AUTH_JSON') || connectedEnvVars.has('OPENCODE_AUTH_JSON');
  const compact: Record<string, T> = {};

  for (const [model, entry] of Object.entries(fullCatalog)) {
    if (model === 'auto' || model === 'kortix/auto') continue;
    const slash = model.indexOf('/');
    const managed = slash === -1;
    const provider = managed ? null : model.slice(0, slash);
    const connected =
      provider === 'codex'
        ? codexConnected
        : provider
          ? isProviderConnected(provider, connectedEnvVars)
          : false;
    if (managed || connected || required.has(model)) compact[model] = entry;
  }

  return compact;
}

/**
 * The flagship `provider/model` ref for the provider whose primary credential
 * env var is `envVar` (e.g. `ANTHROPIC_API_KEY` → `anthropic/claude-opus-4.8`),
 * or null. Used to auto-seed a sensible project default when a user connects
 * their first provider. Non-provider credentials (CODEX_AUTH_JSON,
 * OPENCODE_AUTH_JSON) have no catalog upstream → null, so they're skipped.
 */
export function flagshipRefForEnvVar(envVar: string): string | null {
  const upper = envVar.toUpperCase();
  for (const provider of catalogState().catalog.providers) {
    const upstream = resolveCatalogUpstream(provider.id);
    if (!upstream || upstream.envVar.toUpperCase() !== upper) continue;
    const flagship = providerFlagship(provider.id);
    if (flagship) return `${provider.id}/${flagship}`;
  }
  return null;
}

/** A friendly label for any model ref (managed, BYOK, codex, or raw). */
export function labelForModelRef(ref: string): string {
  const modelById = catalogState().modelById;
  const wire = toWireModel(ref);
  const managed = RUNTIME_MANAGED_MODELS.find((m) => m.id === wire);
  if (managed) return managed.name;
  if (wire.startsWith('codex/')) {
    const inner = wire.slice('codex/'.length);
    return `${modelById.get(`openai/${inner}`)?.name ?? inner} (ChatGPT)`;
  }
  const catalog = modelById.get(wire);
  if (catalog) return catalog.name;
  return ref;
}

/**
 * Managed models as opencode refs (`kortix/<id>`), with tier hints. Reads the
 * SERVED lineup, so a configured model whose transport credential is missing is
 * never offered on a surface where picking it would fail.
 */
export function managedPickerModels(): PickerModel[] {
  return SERVED_MANAGED_MODELS.map((m) => ({
    id: `kortix/${m.id}`,
    label: m.name,
    provider: 'kortix',
    managed: true,
    hint:
      m.tier === 'flagship' ? 'Most capable' : m.tier === 'fast' ? 'Fastest' : 'Balanced, fast',
  }));
}

/** Flagship picker entries for the CONNECTED BYOK providers in `connectedEnvVars`. */
export function connectedByokPickerModels(connectedEnvVars: Set<string>): PickerModel[] {
  const models: PickerModel[] = [];
  for (const provider of catalogState().catalog.providers) {
    if (!isProviderConnected(provider.id, connectedEnvVars)) continue;
    const flagship = providerFlagship(provider.id);
    if (!flagship) continue;
    const id = `${provider.id}/${flagship}`;
    models.push({ id, label: labelForModelRef(id), provider: provider.id, managed: false, hint: provider.name });
  }
  return models;
}
