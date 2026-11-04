/**
 * Tool calls Claude made that pi runs.
 *
 * Claude Code calls an MCP tool and waits for its result. The provider ends pi's model step at
 * that point, pi runs the tool like any model's tool call (permission gate, extensions, the
 * transcript), and the next model step hands the result back here. The `PreToolUse` hook gives
 * the call's id: the MCP handler does not see it. One id is remembered at a time, so every tool
 * runs one at a time (`server.ts` marks none read-only).
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/** A pi tool result for Claude: the MCP result, and the content blocks a PostToolUse hook puts in its place. */
export interface ToolOutcome {
  readonly mcp: CallToolResult
  readonly replacement?: unknown[]
}

interface Call {
  readonly name: string
  readonly result: PromiseWithResolvers<ToolOutcome>
}

export class PendingTools {
  private readonly calls = new Map<string, Call>()
  private readonly replacements = new Map<string, unknown[]>()
  private next: string | undefined

  /** Record a call Claude streamed, before its MCP request arrives. */
  expect(id: string, name: string): Call {
    const saved = this.calls.get(id)
    const call = saved ?? { name, result: Promise.withResolvers<ToolOutcome>() }
    if (!saved) this.calls.set(id, call)
    if (call.name !== name) throw new Error(`Claude tool call ${id} changed its tool`)
    return call
  }

  /** PreToolUse: the next MCP request is this call. */
  before(id: string, name: string): void {
    this.expect(id, name)
    this.next = id
  }

  /** The MCP handler: wait for pi's result of the call PreToolUse named. */
  async call(name: string): Promise<CallToolResult> {
    const id = this.next
    this.next = undefined
    if (!id) throw new Error('Claude called a Kortix tool without its PreToolUse id')
    const call = this.expect(id, name)
    const result = await call.result.promise
    if (result.replacement) this.replacements.set(id, result.replacement)
    this.calls.delete(id)
    return result.mcp
  }

  resolve(id: string, result: ToolOutcome): void {
    const call = this.calls.get(id)
    if (!call) throw new Error(`No Claude tool call ${id} is waiting`)
    call.result.resolve(result)
  }

  /** PostToolUse: the content blocks that replace an MCP result (PDFs and images MCP cannot carry). */
  after(id: string): unknown[] | undefined {
    const replacement = this.replacements.get(id)
    this.replacements.delete(id)
    return replacement
  }

  /** Answer every waiting call as cancelled. Call only after an interrupt drained the turn. */
  clear(): void {
    for (const call of this.calls.values()) {
      call.result.resolve({ mcp: { isError: true, content: [{ type: 'text', text: 'Cancelled by user.' }] } })
    }
    this.calls.clear()
    this.replacements.clear()
    this.next = undefined
  }
}
