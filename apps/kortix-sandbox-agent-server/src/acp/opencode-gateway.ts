import { readFileSync } from 'node:fs'

export type KortixGatewayModel = {
  name: string
  reasoning?: boolean
  tool_call?: boolean
  attachment?: boolean
  temperature?: boolean
  limit?: { context?: number; output?: number }
}

export const DEFAULT_KORTIX_MODEL = 'kortix/auto'

const BAKED_LLM_CATALOG_PATH = '/opt/kortix/llm-catalog.json'
const DEFAULT_MODEL_LIMIT = { context: 200_000, output: 32_000 } as const

const MINIMAL_FALLBACK_MODELS: Record<string, KortixGatewayModel> = {
  auto: {
    name: 'Auto',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 64_000 },
  },
  'claude-opus-4.8': {
    name: 'Claude Opus 4.8',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 64_000 },
  },
  'claude-sonnet-4.6': {
    name: 'Claude Sonnet 4.6',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 64_000 },
  },
  'glm-5.2': {
    name: 'GLM 5.2',
    reasoning: true,
    tool_call: true,
    attachment: false,
    temperature: true,
    limit: { context: 1_000_000, output: 131_072 },
  },
  'openai/gpt-5.5': {
    name: 'GPT-5.5',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: false,
    limit: { context: 1_050_000, output: 64_000 },
  },
  'google/gemini-3.5-flash': {
    name: 'Gemini 3.5 Flash',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 65_536 },
  },
  'google/gemini-3.1-pro-preview': {
    name: 'Gemini 3.1 Pro',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 65_536 },
  },
  'deepseek/deepseek-v4-flash': {
    name: 'DeepSeek V4 Flash',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 64_000 },
  },
  'deepseek/deepseek-v4-pro': {
    name: 'DeepSeek V4 Pro',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 64_000 },
  },
  'minimax/minimax-m3': {
    name: 'MiniMax M3',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 64_000 },
  },
  'moonshotai/kimi-k2.6': {
    name: 'Kimi K2.6',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 262_144, output: 64_000 },
  },
  'z-ai/glm-5.1': {
    name: 'GLM 5.1',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 202_752, output: 64_000 },
  },
  'x-ai/grok-4.3': {
    name: 'Grok 4.3',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 64_000 },
  },
}

const KNOWN_LIMIT_BY_TAIL: Record<string, { context?: number; output?: number }> = (() => {
  const out: Record<string, { context?: number; output?: number }> = {}
  for (const [id, model] of Object.entries(MINIMAL_FALLBACK_MODELS)) {
    if (model.limit) out[id.split('/').pop() ?? id] = model.limit
  }
  return out
})()

function withModelLimits(
  models: Record<string, KortixGatewayModel>,
): Record<string, KortixGatewayModel> {
  const out: Record<string, KortixGatewayModel> = {}
  for (const [id, model] of Object.entries(models)) {
    if (typeof model.limit?.context === 'number' && model.limit.context > 0) {
      out[id] = model
      continue
    }
    const known = KNOWN_LIMIT_BY_TAIL[id.split('/').pop() ?? id]
    out[id] = { ...model, limit: known ?? { ...DEFAULT_MODEL_LIMIT } }
  }
  return out
}

function readCatalogFile(path: string): Record<string, KortixGatewayModel> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as
      | { models?: Record<string, KortixGatewayModel> }
      | Record<string, KortixGatewayModel>
    const models = (parsed && typeof parsed === 'object' && 'models' in parsed
      ? (parsed as { models?: Record<string, KortixGatewayModel> }).models
      : parsed as Record<string, KortixGatewayModel>) ?? {}
    return Object.keys(models).length > 0 ? models : null
  } catch {
    return null
  }
}

export function buildOpencodeKortixProvider(
  env: NodeJS.ProcessEnv,
): Record<string, unknown> | null {
  const baseURL = env.KORTIX_LLM_BASE_URL?.trim()
  const apiKey = env.KORTIX_LLM_API_KEY?.trim()
  if (!baseURL || !apiKey) return null

  const explicitFile = env.KORTIX_LLM_CATALOG_FILE?.trim()
  const models =
    (explicitFile ? readCatalogFile(explicitFile) : null) ??
    readCatalogFile(BAKED_LLM_CATALOG_PATH) ??
    MINIMAL_FALLBACK_MODELS

  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'Kortix',
    options: { baseURL, apiKey },
    models: withModelLimits(models),
  }
}
