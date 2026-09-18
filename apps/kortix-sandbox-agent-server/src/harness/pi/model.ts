/**
 * Model resolution for the pi harness.
 *
 * Every model a session can run is served by the Kortix LLM gateway under
 * the synthetic `kortix` provider — the same provider OpenCode's config
 * registers. pi talks to it through its OpenAI-completions API, pointed at the
 * daemon's localhost LLM proxy when one runs (credential injection, image
 * window) and at the gateway directly otherwise.
 *
 * The picker's catalog comes from the image-baked file the OpenCode path also
 * reads; the selected model comes from `KORTIX_OPENCODE_MODEL` (the control
 * plane's resolved session model — the variable is named for the first
 * harness, the value is harness-neutral), then the compiled agent config.
 */
import { readFileSync } from 'node:fs'
import type { Api, Model } from '@earendil-works/pi-ai'
import {
  InMemoryCredentialStore,
  createModels,
  createProvider,
  envApiKeyAuth,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxProviderHandle,
  type MutableModels,
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { LLM_PROXY_PLACEHOLDER_KEY } from '../../llm-proxy'
import { logger } from '../../logger'

/** Staged unconditionally by apps/api's snapshot build-context. */
export const BAKED_LLM_CATALOG_PATH = '/opt/kortix/llm-catalog.json'
export const KORTIX_PROVIDER_ID = 'kortix'
const PI_THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export interface CatalogModel {
  name?: string
  reasoning?: boolean
  attachment?: boolean
  limit?: { context?: number; input?: number; output?: number }
  variants?: Record<string, unknown>
  reasoning_options?: Array<{ type?: string }>
}

export function readCatalogFile(path: string = process.env.KORTIX_LLM_CATALOG_FILE || BAKED_LLM_CATALOG_PATH): Record<string, CatalogModel> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { models?: Record<string, CatalogModel> } | Record<string, CatalogModel>
    const models = (parsed && typeof parsed === 'object' && 'models' in parsed ? (parsed as { models?: Record<string, CatalogModel> }).models : (parsed as Record<string, CatalogModel>)) ?? {}
    return models
  } catch {
    return {}
  }
}

/** `kortix/<id>` and bare `<id>` both name the gateway model `<id>`. */
export function nativeModelId(ref: string | undefined | null): string | null {
  const raw = (ref ?? '').trim()
  if (!raw) return null
  const id = raw.startsWith(`${KORTIX_PROVIDER_ID}/`) ? raw.slice(KORTIX_PROVIDER_ID.length + 1) : raw
  return id || null
}

/** OpenCode `variant` names that pi can honour as a thinking level. */
export function reasoningVariants(entry: CatalogModel | undefined): string[] {
  if (!entry?.reasoning) return []
  const names = [
    ...Object.keys(entry.variants ?? {}),
    ...(entry.reasoning_options ?? []).map((o) => o.type ?? '').filter(Boolean),
  ]
  return [...new Set(names.filter((name) => PI_THINKING_LEVELS.has(name)))]
}

export interface GatewayTarget {
  baseUrl: string
  apiKey: string
}

/** Where pi sends model requests: the localhost proxy when it runs, else the gateway. */
export function resolveGatewayTarget(env: NodeJS.ProcessEnv = process.env): GatewayTarget | null {
  const proxy = env.KORTIX_LLM_PROXY_URL?.trim()
  if (proxy && env.KORTIX_LLM_PROXY_DISABLE !== '1') return { baseUrl: proxy.replace(/\/+$/, ''), apiKey: LLM_PROXY_PLACEHOLDER_KEY }
  const base = env.KORTIX_LLM_BASE_URL?.trim()
  const token = env.KORTIX_TOKEN?.trim()
  if (!base || !token) return null
  return { baseUrl: base.replace(/\/+$/, ''), apiKey: token }
}

export interface SelectedModel {
  model: Model<Api>
  providerID: string
  modelID: string
  variants: string[]
  images: boolean
  contextWindow: number
}

export interface PiModels {
  models: MutableModels
  /** Resolve a gateway model id (already stripped of `kortix/`), or the default. */
  select(modelId: string | null): SelectedModel
  /** The catalog the picker lists; empty in faux mode. */
  catalog: Record<string, CatalogModel>
  faux: FauxProviderHandle | null
}

function gatewayModel(id: string, entry: CatalogModel | undefined, target: GatewayTarget): Model<'openai-completions'> {
  return {
    id,
    name: entry?.name ?? id,
    api: 'openai-completions',
    provider: KORTIX_PROVIDER_ID,
    baseUrl: target.baseUrl,
    reasoning: entry?.reasoning === true,
    input: entry?.attachment ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry?.limit?.context ?? 128_000,
    maxTokens: entry?.limit?.output ?? 32_768,
    compat: { thinkingFormat: 'openai', supportsStore: false, supportsDeveloperRole: false },
  }
}

export function createFauxScriptResponses(script: readonly unknown[]) {
  return script.map((rawStep) => {
    const step = rawStep && typeof rawStep === 'object' && !Array.isArray(rawStep) ? (rawStep as { tool?: unknown; args?: unknown; text?: unknown }) : {}
    return typeof step.tool === 'string'
      ? fauxAssistantMessage([fauxToolCall(step.tool, (step.args as Record<string, unknown>) ?? {})], { stopReason: 'toolUse' })
      : fauxAssistantMessage(String(step.text ?? ''), { stopReason: 'stop' })
  })
}

export async function createPiModels(input: {
  mode: 'real' | 'faux'
  fauxScript?: string
  env?: NodeJS.ProcessEnv
  defaultModelRef?: string | null
}): Promise<PiModels> {
  const env = input.env ?? process.env
  const credentials = new InMemoryCredentialStore()
  const models = createModels({ credentials })

  if (input.mode === 'faux') {
    const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-1', name: 'Faux' }] })
    models.setProvider(faux.provider)
    if (input.fauxScript) {
      const script = JSON.parse(input.fauxScript) as unknown
      if (!Array.isArray(script)) throw new Error('KORTIX_PI_FAUX_SCRIPT must be a JSON array')
      faux.setResponses(createFauxScriptResponses(script))
    }
    const model = faux.getModel()
    return {
      models,
      catalog: {},
      faux,
      select: () => ({ model, providerID: 'faux', modelID: model.id, variants: [], images: false, contextWindow: model.contextWindow }),
    }
  }

  const target = resolveGatewayTarget(env)
  if (!target) throw new Error('pi harness needs KORTIX_LLM_BASE_URL and KORTIX_TOKEN (the Kortix LLM gateway)')
  const catalog = readCatalogFile(env.KORTIX_LLM_CATALOG_FILE)
  const provider = createProvider({
    id: KORTIX_PROVIDER_ID,
    name: 'Kortix',
    baseUrl: target.baseUrl,
    auth: { apiKey: envApiKeyAuth('Kortix gateway token', ['KORTIX_PI_GATEWAY_KEY']) },
    models: Object.entries(catalog).map(([id, entry]) => gatewayModel(id, entry, target)),
    api: { 'openai-completions': openAICompletionsApi() },
  })
  models.setProvider(provider)
  await credentials.modify(KORTIX_PROVIDER_ID, async () => ({ type: 'api_key', key: target.apiKey }))
  const fallback = nativeModelId(input.defaultModelRef) ?? Object.keys(catalog)[0] ?? null
  if (!fallback) throw new Error('pi harness has no model: no KORTIX_OPENCODE_MODEL and no baked catalog')
  logger.info('[pi] gateway models ready', { baseUrl: target.baseUrl, catalog: Object.keys(catalog).length, fallback })

  return {
    models,
    catalog,
    faux: null,
    select(modelId) {
      const id = modelId ?? fallback
      const entry = catalog[id]
      // A model the picker offers but the baked catalog lacks still routes:
      // the gateway resolves ids server-side, the catalog only sizes the window.
      const model = models.getModel(KORTIX_PROVIDER_ID, id) ?? gatewayModel(id, entry, target)
      return {
        model,
        providerID: KORTIX_PROVIDER_ID,
        modelID: id,
        variants: reasoningVariants(entry),
        images: model.input.includes('image'),
        contextWindow: model.contextWindow,
      }
    },
  }
}
