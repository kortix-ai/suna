import { z } from 'zod'

export interface ToolContext {
  sessionID: string
  messageID: string
  agent: string
  directory: string
  worktree: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void
  ask(input: {
    permission: string
    patterns: string[]
    always: string[]
    metadata: Record<string, unknown>
  }): Promise<void>
}

export type ToolResult =
  | string
  | {
      title?: string
      output: string
      metadata?: Record<string, unknown>
      attachments?: Array<{
        type: 'file'
        mime: string
        url: string
        filename?: string
      }>
    }

export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}) {
  return input
}

tool.schema = z

export interface PluginInput {
  client: any
  project: unknown
  worktree: string
  directory: string
  serverUrl: URL
  $: unknown
}

export type Plugin = (
  input: PluginInput,
) => Promise<Record<string, unknown>> | Record<string, unknown>
