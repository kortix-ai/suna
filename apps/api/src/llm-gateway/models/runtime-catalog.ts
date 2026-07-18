import { CATALOG, type Catalog, type CatalogModel } from '@kortix/llm-catalog';

const DEFAULT_SOURCE_URL = 'https://models.dev/api.json';
// Was 24h — a full day for a new model launch (or a provider's own metadata
// fix) to reach every deployment is a bad user experience once the web
// connect modal reads this SAME live catalog instead of a baked snapshot
// (see apps/web/src/lib/llm-providers.ts). 1h is a large freshness win (24x)
// while staying trivially light on models.dev — one small JSON GET/hour per
// deployment, no auth, no burst — and the existing atomic last-known-good
// swap (see `refresh` below) makes ANY interval safe: a failed/slow fetch
// never replaces `current` with a partial or broken catalog, it just keeps
// serving the last good one and logs the miss.
const DEFAULT_REFRESH_MS = 60 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 15_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface ModelsDevModel extends CatalogModel {
  release_date?: string | null;
}

// Passed straight through from models.dev — no transformation needed, unlike
// `released`/`release_date` above. Kept as its own list (rather than
// spreading `model` wholesale) so a stray upstream field never leaks into
// the normalized `Catalog` shape @kortix/llm-catalog's `CatalogModel`
// declares. Mirrors apps/web/scripts/enrich-llm-catalog-capabilities.ts's
// field set exactly — the baked snapshot and this live path must never
// diverge in SHAPE, only in freshness (see that script's header comment).
const PASSTHROUGH_MODEL_FIELDS = [
  'reasoning_options',
  'structured_output',
  'knowledge',
  'family',
  'modalities',
  'cost',
] as const;

interface ModelsDevProvider {
  id?: string;
  name?: string;
  env?: string[];
  doc?: string;
  api?: string | null;
  npm?: string | null;
  models?: Record<string, ModelsDevModel>;
}

type ModelsDevResponse = Record<string, ModelsDevProvider>;

export interface RuntimeCatalogStatus {
  source: 'seed' | 'api';
  sourceUrl: string;
  revision: number;
  providerCount: number;
  modelCount: number;
  fetchedAt: string;
  lastError?: string;
}

export interface RuntimeModelCatalog {
  snapshot(): Catalog;
  status(): RuntimeCatalogStatus;
  refresh(): Promise<boolean>;
  start(): Promise<void>;
  stop(): void;
}

export interface RuntimeModelCatalogOptions {
  seed: Catalog;
  sourceUrl?: string;
  fetchImpl?: FetchLike;
  refreshIntervalMs?: number;
  timeoutMs?: number;
  logger?: Pick<Console, 'info' | 'warn'>;
}

function normalizeCatalog(data: ModelsDevResponse, sourceUrl: string, fetchedAt: string): Catalog {
  const providers: Catalog['providers'] = [];
  let modelCount = 0;

  for (const [providerKey, provider] of Object.entries(data)) {
    if (!provider || typeof provider !== 'object') continue;
    const id = provider.id || providerKey;
    const models = Object.entries(provider.models ?? {}).map(([modelKey, model]) => {
      const passthrough: Record<string, unknown> = {};
      for (const field of PASSTHROUGH_MODEL_FIELDS) {
        if (model[field] !== undefined) passthrough[field] = model[field];
      }
      return {
        id: model.id || modelKey,
        name: model.name || model.id || modelKey,
        released: model.released ?? model.release_date ?? null,
        attachment: model.attachment,
        reasoning: model.reasoning,
        tool_call: model.tool_call,
        temperature: model.temperature,
        limit: model.limit,
        ...passthrough,
      } as CatalogModel;
    });
    modelCount += models.length;
    providers.push({
      id,
      name: provider.name || id,
      env: Array.isArray(provider.env) ? provider.env : undefined,
      doc: provider.doc,
      api: provider.api,
      npm: provider.npm,
      models,
    });
  }

  if (providers.length === 0 || modelCount === 0) {
    throw new Error('catalog API returned no providers or models');
  }

  return {
    source: sourceUrl,
    fetched_at: fetchedAt,
    provider_count: providers.length,
    model_count: modelCount,
    providers,
  };
}

export function createRuntimeModelCatalog(
  options: RuntimeModelCatalogOptions,
): RuntimeModelCatalog {
  const sourceUrl = options.sourceUrl ?? DEFAULT_SOURCE_URL;
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logger = options.logger ?? console;

  let current = options.seed;
  let source: RuntimeCatalogStatus['source'] = 'seed';
  let revision = 0;
  let lastError: string | undefined;
  let timer: ReturnType<typeof setInterval> | null = null;

  const status = (): RuntimeCatalogStatus => ({
    source,
    sourceUrl,
    revision,
    providerCount: current.provider_count,
    modelCount: current.model_count,
    fetchedAt: current.fetched_at,
    ...(lastError ? { lastError } : {}),
  });

  const refresh = async (): Promise<boolean> => {
    try {
      const response = await fetchImpl(sourceUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const fetchedAt = new Date().toISOString();
      const next = normalizeCatalog(
        (await response.json()) as ModelsDevResponse,
        sourceUrl,
        fetchedAt,
      );

      // Atomic reference swap: request readers see either the complete old
      // catalog or the complete new one, never a partially refreshed registry.
      current = next;
      source = 'api';
      revision += 1;
      lastError = undefined;
      logger.info(
        `[llm-gateway] loaded runtime catalog from ${sourceUrl} (${next.provider_count} providers, ${next.model_count} models)`,
      );
      return true;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[llm-gateway] runtime catalog refresh failed; keeping last known catalog: ${lastError}`,
      );
      return false;
    }
  };

  return {
    snapshot: () => current,
    status,
    refresh,
    async start(): Promise<void> {
      await refresh();
      if (timer || refreshIntervalMs <= 0) return;
      timer = setInterval(() => void refresh(), refreshIntervalMs);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}

export const runtimeModelCatalog = createRuntimeModelCatalog({
  seed: CATALOG,
  sourceUrl: process.env.LLM_GATEWAY_CATALOG_URL || DEFAULT_SOURCE_URL,
});
