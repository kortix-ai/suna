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

/**
 * Reads Platinum's `/models` into the lineup. On any failure the last good
 * lineup stays and the error is logged; returns whether the read succeeded.
 */
export async function loadManagedLineup(fetchImpl: FetchLike = fetch): Promise<boolean> {
  if (!config.KORTIX_MANAGED_PROVIDER_ENABLED || !config.PLATINUM_INFERENCE_API_KEY) {
    if (lineup.length) setLineup([]);
    return true;
  }
  const url = `${config.PLATINUM_INFERENCE_URL.replace(/\/+$/, '')}/models`;
  try {
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${config.PLATINUM_INFERENCE_API_KEY}` },
      signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const models = managedModelsFromPlatinum(await res.json());
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

// Exported (read-only) so a test can iterate every declared alias and assert
// its FULLY RESOLVED chain lands on something still current — the guard
// against the exact bug this map just had: an alias whose one-hop target got
// retired out from under it and nobody revisited the alias.
export const LEGACY_MANAGED_IDS: Readonly<Record<string, string>> = {
  'morph-kimik3': 'kimi-k3',
  'morph-kimik3-fast': 'kimi-k3-fast',
  'morph-dsv41flash': 'deepseek-v4.1-flash',
  'morph-dsv4flash': 'deepseek-v4-flash-0731',
  'deepseek-v4-flash': 'deepseek-v4-flash-0731',
  // deepseek-v4-flash-0731 was itself retired 2026-09-28 in favor of
  // deepseek-v4.1-flash — see RETIRED_MANAGED_MODEL_IDS above.
  'deepseek-v4-flash-0731': 'deepseek-v4.1-flash',
  // kimi-k3-fast (the ONE-HOP target of morph-kimik3-fast above) is itself
  // retired — the fast tier merged into kimi-k3. Found by the chain-
  // resolution guard test below, 2026-09-28, the same bug class as
  // deepseek-v4-flash-0731 above: a target retired out from under its alias.
  'kimi-k3-fast': 'kimi-k3',
  'kimi-k3': 'deepseek-v4.1-flash',
};

// Bounds chain resolution below. This map is hand-maintained: retiring a
// model whose id is itself the TARGET of an older alias (deepseek-v4-flash-
// 0731 was both — see the two entries above it) creates a two-hop chain, and
// nothing stops a third. A bound plus cycle detection means a data bug here
// degrades to "stop resolving" rather than hanging a turn.
const CANONICAL_CHAIN_MAX_HOPS = 8;

/**
 * Follows `table` to its end, not just one hop — a retired id can itself be
 * superseded (deepseek-v4-flash-0731 was the declared successor for
 * morph-dsv4flash/deepseek-v4-flash, then was itself retired in favor of
 * deepseek-v4.1-flash; a single lookup would leave those two aliases pointing
 * at a now-also-retired id). Stops at the first id that is not itself a key,
 * or after `maxHops` hops, or the instant a hop would repeat an id already
 * seen (a cycle) — whichever comes first. `table` is injected so this stays
 * pure and testable against a synthetic chain/cycle without mutating the real
 * (hand-maintained) map. The caller-side retirement checks (resolve-
 * candidates.ts, session-model-repoint.ts) still treat a not-fully-resolved
 * retired id correctly, so stopping early here is safe: it never fabricates a
 * wrong answer, only leaves one still-retired.
 */
export function resolveLegacyIdChain(
  id: string,
  table: Readonly<Record<string, string>>,
  maxHops: number = CANONICAL_CHAIN_MAX_HOPS,
): string {
  let current = id;
  const seen = new Set([current]);
  for (let hop = 0; hop < maxHops; hop++) {
    const next = table[current];
    if (next === undefined || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
  return current;
}

export function canonicalManagedModelId(id: string): string {
  return resolveLegacyIdChain(id, LEGACY_MANAGED_IDS);
}

/** In the current lineup, or a retired id stored sessions may still carry. */
export function isKnownManagedModelId(id: string): boolean {
  return byId.has(id) || RETIRED_MANAGED_MODEL_IDS.has(id);
}

/** Explicitly retired — distinct from merely "not currently servable". */
export function isRetiredManagedModelId(id: string): boolean {
  return RETIRED_MANAGED_MODEL_IDS.has(id);
}

/**
 * The declared successor for a retired id, ONLY when that successor is
 * itself in `served` — never a dead pin swapped for another dead pin.
 * `null` when the id isn't retired, has no declared successor
 * (LEGACY_MANAGED_IDS), or the successor isn't servable here either.
 */
export function retiredManagedModelReplacement(id: string, served: readonly ManagedModel[]): string | null {
  if (!isRetiredManagedModelId(id)) return null;
  const successor = canonicalManagedModelId(id);
  return successor !== id && served.some((model) => model.id === successor) ? successor : null;
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
  const alias = canonicalManagedModelId(bare);
  if (alias !== bare && served.some((model) => model.id === alias)) return alias;
  return served[0]?.id ?? trimmed;
}
