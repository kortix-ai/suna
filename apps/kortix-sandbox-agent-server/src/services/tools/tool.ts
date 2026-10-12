/**
 * The Kortix tool contract: one module, every harness.
 *
 * A tool is a module whose default export is a plain object. It imports
 * nothing from a harness, so OpenCode, pi and any later harness run the same
 * file:
 *
 *   export default {
 *     description: 'Look up an order by id.',
 *     parameters: {
 *       type: 'object',
 *       properties: { id: { type: 'string', description: 'The order id' } },
 *       required: ['id'],
 *     },
 *     async execute(args, context) {
 *       return `order ${args.id}: shipped`
 *     },
 *   }
 *
 * `parameters` is JSON Schema, the format every model API takes. `execute`
 * returns a string, or any JSON value (sent as indented JSON). A thrown error
 * is the tool's error. A secret is `context.env.NAME`. The project declares
 * the module in kortix.yaml `tools:` (name → repo-relative path); the folder
 * is the author's choice.
 */

/** What a running tool knows about its call. */
export interface ToolContext {
  /** The Kortix session the call belongs to. */
  sessionId: string
  /** The agent that made the call. */
  agent: string
  /** The project checkout the session works in: a relative path resolves here. */
  directory: string
  /**
   * The session environment: the box env with the project secrets this agent
   * receives, as they are now (a secret changed after boot is here, not in
   * `process.env`).
   */
  env: Record<string, string | undefined>
  /** Aborts when the turn stops. */
  signal: AbortSignal
}

export interface KortixTool {
  description: string
  /** JSON Schema of the arguments; `type: 'object'`. */
  parameters: Record<string, unknown>
  execute(args: Record<string, any>, context: ToolContext): unknown
}

/** A module's default export as a tool, or why it is not one. */
export function asTool(value: unknown): KortixTool | string {
  if (!value || typeof value !== 'object') return 'the module has no default export object'
  const tool = value as Partial<KortixTool>
  if (typeof tool.description !== 'string' || !tool.description.trim()) return '`description` must be a non-empty string'
  if (!tool.parameters || typeof tool.parameters !== 'object' || tool.parameters.type !== 'object') {
    return '`parameters` must be a JSON Schema object (`{ type: "object", properties: { … } }`)'
  }
  if (typeof tool.execute !== 'function') return '`execute(args, context)` must be a function'
  return tool as KortixTool
}

/** The text a model reads: a string as it is, any other value as indented JSON. */
export function toolText(result: unknown): string {
  if (typeof result === 'string') return result
  if (result === undefined) return ''
  return JSON.stringify(result, null, 2) ?? String(result)
}
