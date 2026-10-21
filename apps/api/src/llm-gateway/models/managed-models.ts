import type { CatalogReasoningOption } from '@kortix/llm-catalog';
import { config } from '../../config';
import { logger } from '../../lib/logger';

/**
 * A Kortix managed model: one model Platinum Inference offers, paid from
 * Kortix credits. Platinum's `GET /v1/inference/models` is the only source;
 * nothing here lists or prices a model.
 */
export interface ManagedModel {
  id: string;
  name: string;
  // Platinum's price per 1M tokens. The gateway bills Platinum's `usage.cost`;
  // this applies only when a response carries none.
  pricing: { inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion?: number };
  // Image input. Also sets the served `modalities`: OpenCode drops image parts
  // for a model without `image` input.
  vision: boolean;
  // `reasoning_effort` values Platinum accepts; the thinking control's variants.
  reasoningOptions?: CatalogReasoningOption[];
  limit: { context: number; output: number };
}

/** One entry of Platinum's `/models` list, as far as this file reads it. */
type PlatinumModel = {
  id?: unknown; name?: unknown; owned_by?: unknown;
  context_length?: unknown; max_output_tokens?: unknown;
  pricing?: { input?: unknown; cached_input?: unknown; output?: unknown };
  modalities?: { input?: unknown };
  reasoning_efforts?: unknown;
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Platinum's named models → the lineup, in Platinum's order. Entries without a price are skipped. */
export function managedModelsFromPlatinum(body: unknown): ManagedModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error('Platinum /models answered without a data list');
  const out: ManagedModel[] = [];
  for (const m of data as PlatinumModel[]) {
    const input = num(m.pricing?.input);
    const output = num(m.pricing?.output);
    const context = num(m.context_length);
    const maxOutput = num(m.max_output_tokens);
    if (m.owned_by !== 'platinum' || typeof m.id !== 'string' || !m.id || input === undefined || output === undefined
      || !context || !maxOutput) continue;
    const cached = num(m.pricing?.cached_input);
    const efforts = Array.isArray(m.reasoning_efforts) ? m.reasoning_efforts.filter((e): e is string => typeof e === 'string') : [];
    out.push({
      id: m.id,
      name: typeof m.name === 'string' && m.name ? m.name : m.id,
      pricing: { inputPerMillion: input, outputPerMillion: output, ...(cached !== undefined ? { cachedInputPerMillion: cached } : {}) },
      vision: Array.isArray(m.modalities?.input) && m.modalities.input.includes('image'),
      ...(efforts.length ? { reasoningOptions: [{ type: 'effort', values: efforts }] as CatalogReasoningOption[] } : {}),
      limit: { context, output: maxOutput },
    });
  }
  return out;
}

let lineup: readonly ManagedModel[] = [];
// replica-local: every replica loads the same Platinum list and refreshes it
// every 5 min (workers/managed-lineup-worker.ts); a copy is at most that old.
let byId = new Map<string, ManagedModel>();
let revision = 0;

function setLineup(models: readonly ManagedModel[]): void {
  lineup = models;
  byId = new Map(models.map((model) => [model.id, model] as const));
  revision++;
}

/**
 * The managed lineup: what Platinum Inference offers right now. Empty when the
 * managed provider is off (self-host) or Platinum was never reached.
 */
export function managedLineup(): readonly ManagedModel[] {
  return lineup;
}

/** Bumps on every lineup change, so derived caches know to rebuild. */
export function managedLineupRevision(): number {
  return revision;
}

export function getRuntimeManagedModel(id: string): ManagedModel | undefined {
  return byId.get(id);
}

export function isRuntimeManagedModelId(id: string): boolean {
  return byId.has(id);
}

export function __setManagedLineupForTest(models: readonly ManagedModel[]): void {
  setLineup(models);
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const LOAD_TIMEOUT_MS = 10_000;

/** HTTP status of a failed Platinum `/models` read, so a caller can tell a bad key from an outage. */
export class PlatinumModelsError extends Error {
  constructor(readonly status: number | null, message: string) { super(message); }
}

/**
 * Platinum's named models for one key: `GET {baseUrl}/models`. The one reader
 * for both the managed lineup (the deployment's key) and the Platinum BYOK
 * provider (a project's own key, platinum-byok-models.ts).
 */
export async function fetchPlatinumModels(baseUrl: string, apiKey: string, fetchImpl: FetchLike = fetch): Promise<ManagedModel[]> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PlatinumModelsError(null, err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw new PlatinumModelsError(res.status, `HTTP ${res.status}`);
  return managedModelsFromPlatinum(await res.json());
}

/**
 * Reads Platinum's `/models` into the lineup. On any failure the last good
 * lineup stays and the error is logged; returns whether the read succeeded.
 */
export async function loadManagedLineup(fetchImpl: FetchLike = fetch): Promise<boolean> {
  if (!config.KORTIX_MANAGED_PROVIDER_ENABLED || !config.PLATINUM_INFERENCE_API_KEY) {
    if (lineup.length) setLineup([]);
    return true;
  }
  try {
    const models = await fetchPlatinumModels(config.PLATINUM_INFERENCE_URL, config.PLATINUM_INFERENCE_API_KEY, fetchImpl);
    const changed = JSON.stringify(models) !== JSON.stringify(lineup);
    if (changed) {
      setLineup(models);
      logger.info('[managed-lineup] loaded from Platinum Inference', { models: models.map((m) => m.id) });
    }
    return true;
  } catch (err) {
    logger.warn('[managed-lineup] Platinum /models failed; keeping the last lineup', {
      error: err instanceof Error ? err.message : String(err), kept: lineup.length,
    });
    return false;
  }
}

const RETIRED_MANAGED_MODEL_IDS = new Set([
  'glm-5.2', 'grok-4.6', 'deepseek-v4-flash', 'deepseek-v4-pro-0813',
  'muse-spark-1.2', 'minimax-m3', 'gpt-5.6-luna', 'gpt-6-astra',
  'morph-glm53-744b', 'morph-dsv4flash', 'morph-kimik3',
  'morph-kimik3-fast', 'morph-dsv41flash',
  'deepseek-v4-flash-0731', 'kimi-k3-fast',
  // 2026-10-19: Kimi K3 left the managed lineup; its sessions move to the default.
  'kimi-k3',
]);

/**
 * A stored managed id as the gateway should serve it: a retired id becomes the
 * first model Platinum lists (its preferred default); anything else is itself.
 * No successor is hardcoded: the lineup decides.
 */
export function canonicalManagedModelId(id: string): string {
  return RETIRED_MANAGED_MODEL_IDS.has(id) ? (lineup[0]?.id ?? id) : id;
}

/** In the current lineup, or a retired id stored sessions may still carry. */
export function isKnownManagedModelId(id: string): boolean {
  return byId.has(id) || RETIRED_MANAGED_MODEL_IDS.has(id);
}

/** Explicitly retired — distinct from merely "not currently servable". */
export function isRetiredManagedModelId(id: string): boolean {
  return RETIRED_MANAGED_MODEL_IDS.has(id);
}

/** Strip the opencode `kortix/` namespace off a managed ref. */
function bareManagedId(ref: string): string {
  return ref.startsWith('kortix/') ? ref.slice('kortix/'.length) : ref;
}

/**
 * The platform default model, guaranteed reachable.
 *
 * `configured` (`LLM_GATEWAY_DEFAULT_MODEL`) is what an operator asked for.
 * Empty, or a managed id Platinum does not serve now: the first served model
 * (Platinum lists in order of preference). A BYOK ref (`provider/model`) is
 * returned untouched: it resolves from a project key, and
 * `degradeUnservableDefault` probes that case per project.
 */
export function resolvePlatformDefaultModelId(
  configured: string,
  served: readonly ManagedModel[],
): string {
  const trimmed = configured.trim();
  if (trimmed.includes('/') && !trimmed.startsWith('kortix/')) return trimmed;
  const bare = bareManagedId(trimmed);
  if (bare && served.some((model) => model.id === bare)) return trimmed;
  return served[0]?.id ?? trimmed;
}
