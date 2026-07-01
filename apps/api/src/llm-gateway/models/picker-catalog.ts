import type { Effect } from 'effect';
import { resolveCatalogUpstream } from '@kortix/llm-gateway';
import { CATALOG, type CatalogModel, MANAGED_MODELS } from '@kortix/llm-catalog';
import { toWireModel } from '../resolution/effective';

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

// provider/model id → catalog model, and the per-provider model id set, built
// once at load. Used both to LABEL a ref and to verify a flagship candidate
// actually exists before we ever offer it (no stale ids).
const catalogModelById = new Map<string, CatalogModel>();
const providerModelIds = new Map<string, Set<string>>();
for (const provider of CATALOG.providers) {
  const ids = new Set<string>();
  for (const model of provider.models) {
    catalogModelById.set(`${provider.id}/${model.id}`, model);
    ids.add(model.id);
  }
  providerModelIds.set(provider.id, ids);
}

// Curated flagship candidates per provider, in priority order. Every candidate is
// VERIFIED against the catalog before use, and there's a data-driven fallback
// (most recently released), so a wrong/renamed guess is dropped rather than
// offered — the list can never drift into a lie.
const FLAGSHIP_CANDIDATES: Record<string, string[]> = {
  anthropic: ['claude-opus-4.8', 'claude-opus-4-8', 'claude-sonnet-4.6', 'claude-sonnet-4-6'],
  openai: ['gpt-5.5', 'gpt-5.1', 'gpt-5', 'gpt-4.1'],
  google: ['gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  'x-ai': ['grok-4', 'grok-3'],
  xai: ['grok-4', 'grok-3'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  mistral: ['mistral-large-latest', 'mistral-large'],
  groq: ['llama-3.3-70b-versatile'],
  perplexity: ['sonar-pro', 'sonar'],
};

/** The flagship BYOK model id (bare, no provider prefix) for a provider, or null. */
export function providerFlagship(providerId: string): string | null {
  const ids = providerModelIds.get(providerId);
  if (!ids || ids.size === 0) return null;
  for (const candidate of FLAGSHIP_CANDIDATES[providerId] ?? []) {
    if (ids.has(candidate)) return candidate;
  }
  // Fallback: the most recently released model the catalog carries for this
  // provider (deterministic, real). Released dates sort lexically (YYYY-MM-DD).
  const provider = CATALOG.providers.find((p) => p.id === providerId);
  if (!provider || provider.models.length === 0) return null;
  const sorted = [...provider.models].sort((a, b) =>
    (b.released ?? '').localeCompare(a.released ?? ''),
  );
  return sorted[0]?.id ?? null;
}

/** Whether a provider exposes a BYOK upstream and is connected for `connectedEnvVars`. */
export function isProviderConnected(providerId: string, connectedEnvVars: Set<string>): boolean {
  const upstream = resolveCatalogUpstream(providerId);
  return !!upstream && connectedEnvVars.has(upstream.envVar.toUpperCase());
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
  for (const provider of CATALOG.providers) {
    const upstream = resolveCatalogUpstream(provider.id);
    if (!upstream || upstream.envVar.toUpperCase() !== upper) continue;
    const flagship = providerFlagship(provider.id);
    if (flagship) return `${provider.id}/${flagship}`;
  }
  return null;
}

/** A friendly label for any model ref (managed, BYOK, codex, or raw). */
export function labelForModelRef(ref: string): string {
  const wire = toWireModel(ref);
  const managed = MANAGED_MODELS.find((m) => m.id === wire);
  if (managed) return managed.name;
  if (wire.startsWith('codex/')) {
    const inner = wire.slice('codex/'.length);
    return `${catalogModelById.get(`openai/${inner}`)?.name ?? inner} (ChatGPT)`;
  }
  const catalog = catalogModelById.get(wire);
  if (catalog) return catalog.name;
  return ref;
}

/** Managed models as opencode refs (`kortix/<id>`), with tier hints. */
export function managedPickerModels(): PickerModel[] {
  return MANAGED_MODELS.map((m) => ({
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
  for (const provider of CATALOG.providers) {
    if (!isProviderConnected(provider.id, connectedEnvVars)) continue;
    const flagship = providerFlagship(provider.id);
    if (!flagship) continue;
    const id = `${provider.id}/${flagship}`;
    models.push({ id, label: labelForModelRef(id), provider: provider.id, managed: false, hint: provider.name });
  }
  return models;
}
