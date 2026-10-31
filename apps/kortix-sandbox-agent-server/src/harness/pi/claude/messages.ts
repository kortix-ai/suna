/**
 * pi's model context as Claude Code input.
 *
 * Claude Code cannot be given turns it did not write, so earlier turns that only pi holds
 * (another model's replies, a restored session) go in as one user message with each message's
 * role as a text tag (`catchUp`). Images stay real image blocks.
 */
import type { ImageContent, Message, TextContent, ToolResultMessage } from '@earendil-works/pi-ai'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ToolOutcome } from './pending'

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

function image(part: ImageContent): ContentBlock {
  if (!IMAGE_TYPES.has(part.mimeType)) return { type: 'text', text: `[An attachment of type ${part.mimeType} was omitted: Claude takes PNG, JPEG, GIF and WebP images.]` }
  return { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data } }
}

function parts(content: string | readonly (TextContent | ImageContent)[]): ContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  const blocks: ContentBlock[] = []
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text })
    } else if (part.type === 'image') blocks.push(image(part))
  }
  return blocks
}

/** The content of `messages` as Claude input. With history in it, each message is wrapped in its role tag. */
export function content(messages: readonly Message[]): ContentBlock[] {
  const blocks: ContentBlock[] = []
  const history = messages.some((message) => message.role === 'assistant' || message.role === 'toolResult')
  for (const message of messages) {
    if (message.role === 'system') continue
    const role = message.role === 'toolResult' ? 'tool' : message.role
    if (history) blocks.push({ type: 'text', text: `<${role}>` })
    if (message.role === 'user') blocks.push(...parts(message.content))
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text })
        if (part.type === 'toolCall') {
          const call = JSON.stringify({ id: part.id, name: part.name, input: part.arguments })
          blocks.push({ type: 'text', text: `<tool-call>\n${call}\n</tool-call>` })
        }
      }
    }
    if (message.role === 'toolResult') {
      const text = message.content.filter((part): part is TextContent => part.type === 'text').map((part) => part.text).join('\n')
      const result = JSON.stringify({ id: message.toolCallId, name: message.toolName, error: message.isError || undefined, output: text })
      blocks.push({ type: 'text', text: `<tool-result>\n${result}\n</tool-result>` })
      for (const part of message.content) if (part.type === 'image') blocks.push(image(part))
    }
    if (history) blocks.push({ type: 'text', text: `</${role}>` })
  }
  return blocks
}

/** pi's result of one tool call as the MCP result Claude Code waits for. */
export function toolOutcome(result: ToolResultMessage): ToolOutcome {
  const mcp: CallToolResult = { content: [], isError: result.isError }
  for (const part of result.content) {
    if (part.type === 'text') mcp.content.push({ type: 'text', text: part.text })
    else if (part.type === 'image') {
      if (IMAGE_TYPES.has(part.mimeType)) mcp.content.push({ type: 'image', data: part.data, mimeType: part.mimeType })
      else mcp.content.push({ type: 'text', text: `[An attachment of type ${part.mimeType} was omitted.]` })
    }
  }
  // An MCP result with no content reads as a failure to Claude; say there was no output instead.
  if (mcp.content.length === 0) mcp.content.push({ type: 'text', text: '(no output)' })
  return { mcp }
}
