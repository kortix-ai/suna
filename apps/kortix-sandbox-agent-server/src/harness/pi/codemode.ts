/**
 * pi's `codemode` tool (pi-coding-agent `createCodemodeExtension`): the model writes a
 * JavaScript script that calls the other tools as `tools.<name>(args)`, in a QuickJS
 * sandbox, and only the script's output reaches the model. kortix.yaml
 * `harnesses.pi.codemode` (`KORTIX_PI_CODEMODE`) picks `off`, `on` (the other tools stay
 * declared; the default) or `only` (the model gets codemode alone).
 *
 * A script's tool calls are nested calls (`ctx.executeTool`): pi runs them through the
 * extension `tool_call` handlers, never through `agent.beforeToolCall`, so the runtime
 * gates them in its own handler (runtime.ts `nestedCallGate`).
 */
import type { InlineExtension } from '@earendil-works/pi-coding-agent'
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
