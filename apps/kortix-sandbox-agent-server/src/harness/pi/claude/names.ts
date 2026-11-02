/**
 * The names Claude sees for pi's tools. Claude Code serves every tool of an MCP server as
 * `mcp__<server>__<tool>`, and an MCP tool name is at most 64 characters.
 */
import { createHash } from 'node:crypto'

export const SERVER = 'kortix'
export const PREFIX = `mcp__${SERVER}__`

/** The MCP name of a pi tool: the tool name when it fits and is MCP-safe, else a hashed form. */
export function short(name: string): string {
  const limit = 64 - PREFIX.length
  if (name.length <= limit && /^[a-zA-Z0-9_-]+$/.test(name)) return name
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 10)
  return `${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, limit - 11)}_${hash}`
}

/** The pi tool behind a name Claude called, or undefined for a tool Kortix did not offer. */
export function original(name: string, tools: readonly { name: string }[]): string | undefined {
  return tools.find((tool) => PREFIX + short(tool.name) === name)?.name
}

/** Claude Code cuts each MCP tool description at this many characters. */
const DESCRIPTION_LIMIT = 2048

export function description(text: string): string {
  return text.slice(0, DESCRIPTION_LIMIT)
}
