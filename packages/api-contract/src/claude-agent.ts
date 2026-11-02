/**
 * Claude models on the user's own Claude subscription.
 *
 * A model of the `claude-agent` provider runs through the unmodified Claude Code program in
 * the session's sandbox (the Claude Agent SDK). Claude Code makes the model calls with the
 * session user's own Claude login, straight to Anthropic: these models never go through the
 * Kortix LLM gateway and use no Kortix credits. A model ref is `claude-agent/<id>`, where the
 * id is Claude Code's own model alias.
 *
 * kortixd bundles this file, so it imports nothing.
 */

export const CLAUDE_AGENT_PROVIDER_ID = 'claude-agent' as const

/** The provider's display name. Anthropic's SDK branding rules allow "Claude Agent", not "Claude Code". */
export const CLAUDE_AGENT_PROVIDER_NAME = 'Claude subscription'

/** Claude Code's effort levels. Every model below takes all of them. */
export const CLAUDE_AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type ClaudeAgentEffort = (typeof CLAUDE_AGENT_EFFORTS)[number]

export interface ClaudeAgentModel {
  /** Claude Code's model alias: what `claude --model` takes. */
  readonly id: string
  readonly name: string
  /** The model Claude Code 2.1.316 resolves the alias to. */
  readonly resolved: string
  readonly description: string
  /** Tokens, as Claude Code reports it (`getContextUsage().rawMaxTokens`). */
  readonly context: number
  readonly output: number
}

/** Claude Code 2.1.316's model list (`initializationResult().models`), without `default`. */
export const CLAUDE_AGENT_MODELS: readonly ClaudeAgentModel[] = [
  { id: 'opus', name: 'Claude Opus 5.5', resolved: 'claude-opus-5-5', description: 'Best for everyday, complex tasks', context: 1_000_000, output: 64_000 },
  { id: 'fable', name: 'Claude Fable 5.1', resolved: 'claude-fable-5-1', description: 'Most capable, for the hardest and longest tasks', context: 1_000_000, output: 64_000 },
  { id: 'sonnet', name: 'Claude Sonnet 5.5', resolved: 'claude-sonnet-5-5', description: 'Efficient for routine tasks', context: 1_000_000, output: 64_000 },
  { id: 'haiku', name: 'Claude Haiku 5.5', resolved: 'claude-haiku-5-5', description: 'Fastest, for quick tasks', context: 1_000_000, output: 64_000 },
]

export const CLAUDE_AGENT_DEFAULT_MODEL = 'opus'

/** `claude-agent/<id>` → `<id>`; null for a ref of another provider. */
export function claudeAgentModelId(ref: string | null | undefined): string | null {
  const raw = (ref ?? '').trim()
  const prefix = `${CLAUDE_AGENT_PROVIDER_ID}/`
  if (!raw.startsWith(prefix)) return null
  return raw.slice(prefix.length) || null
}

export function isClaudeAgentModelRef(ref: string | null | undefined): boolean {
  return claudeAgentModelId(ref) !== null
}
