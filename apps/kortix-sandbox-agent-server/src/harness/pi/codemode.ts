/**
 * pi's `codemode` tool (pi-coding-agent `createCodemodeExtension`): the model writes a
 * JavaScript script that calls the other tools as `tools.<name>(args)`, in a QuickJS
 * sandbox, and only the script's output reaches the model. kortix.yaml
 * `harnesses.pi.codemode` (`KORTIX_PI_CODEMODE`) picks `off`, `on` (the other tools stay
 * declared; the default) or `only` (the model gets codemode plus direct output presentation).
 *
 * A script's tool calls are nested calls (`ctx.executeTool`): pi runs them through the
 * extension `tool_call` handlers, never through `agent.beforeToolCall`, so the runtime
 * gates them in its own handler (runtime.ts `nestedCallGate`).
 *
 * A subagent is a bare `core.Agent`, not an AgentSession, so it loads no extension and its
 * tools get no session context: `childCodemodeTool` builds its codemode tool and passes one.
 */
import type { AgentTool, AgentToolCall, AgentToolCallOutcome } from '@earendil-works/pi-agent-core'
import type { ExtensionToolContext, InlineExtension } from '@earendil-works/pi-coding-agent'
// Bun embeds a `.wasm` import in a compiled binary and evaluates it to a readable path.
import quickjsWasmPath from 'quickjs-wasi/quickjs.wasm'
// ponytail: pi does not export this setter (its own Bun entry calls it), so the relative path reaches the same
// module its package entry loads. Import it from the package once pi exports it.
import { setEmbeddedQuickJSWasmPath } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/config.js'

export type CodemodeMode = 'off' | 'on' | 'only'

export const CODEMODE_TOOL = 'codemode'

/** The codemode extension, or none when the mode is `off`. `models` stays off: it would bypass the LLM gateway. */
export function codemodeExtensions(mode: CodemodeMode, create: typeof import('@earendil-works/pi-coding-agent').createCodemodeExtension): InlineExtension[] {
  if (mode === 'off') return []
  // Outside a compiled binary pi resolves the wasm itself; the embedded path is the same file there.
  setEmbeddedQuickJSWasmPath(quickjsWasmPath)
  return [{ name: CODEMODE_TOOL, hidden: true, factory: create({ mode, models: false }) }]
}

/**
 * A subagent's codemode tool: scripts call `tools`, and `run` executes each call (id
 * `<codemode call id>/<n>`, as pi numbers nested calls). The caller gates `run` exactly as a
 * direct call. pi's executor reads `ctx.tools`, `ctx.executeTool` and
 * `ctx.sessionManager.getBranch()` (`ctx.modelRegistry` only with `models`), so the context
 * has those alone. Nothing appends the `store()` writes: they last one script.
 */
export async function childCodemodeTool(
  tools: AgentTool<any, any>[],
  run: (call: AgentToolCall, signal?: AbortSignal) => Promise<AgentToolCallOutcome>,
): Promise<AgentTool<any, any>> {
  // ponytail: pi exports only the extension, which needs an AgentSession. Import the tool from the package once pi
  // exports it. Loaded here, not at import: runtime.ts imports this module on every boot.
  const { createCodemodeTool } = await import('../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/tool.js')
  setEmbeddedQuickJSWasmPath(quickjsWasmPath)
  const tool = createCodemodeTool(tools, { models: false })
  // pi's tool takes the session context as a fifth argument; core.Agent passes four.
  const execute = tool.execute as (...args: [...Parameters<typeof tool.execute>, ExtensionToolContext]) => ReturnType<typeof tool.execute>
  const bound: typeof tool = {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate) => {
      let calls = 0
      const executeTool: ExtensionToolContext['executeTool'] = (name, args, options) =>
        run({ type: 'toolCall', id: `${toolCallId}/${++calls}`, name, arguments: (args ?? {}) as AgentToolCall['arguments'] }, options?.signal ?? signal)
      const ctx = { tools, executeTool, sessionManager: { getBranch: () => [] } }
      return execute(toolCallId, params, signal, onUpdate, ctx as unknown as ExtensionToolContext)
    },
  }
  return bound
}
