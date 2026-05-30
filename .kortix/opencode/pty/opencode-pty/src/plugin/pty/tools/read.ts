import { tool } from '@opencode-ai/plugin'
import { manager } from '../manager.ts'
import { DEFAULT_READ_LIMIT, MAX_LINE_LENGTH } from '../../../shared/constants.ts'
import { buildSessionNotFoundError } from '../utils.ts'
import { formatLine } from '../formatters.ts'
import type { PTYSessionInfo } from '../types.ts'
import DESCRIPTION from './read.txt'

interface ReadArgs {
  id: string
  offset?: number
  limit?: number
  pattern?: string
  ignoreCase?: boolean
}

/**
 * Formats PTY output with XML tags and pagination
 */
function formatPtyOutput(
  id: string,
  status: string,
  pattern: string | undefined,
  formattedLines: string[],
  hasMore: boolean,
  paginationMessage: string,
  endMessage: string
): string {
  const inner = [
    `<pty_output id="${id}" status="${status}"${pattern ? ` pattern="${pattern}"` : ''}>`,
    ...formattedLines,
    '',
    hasMore ? paginationMessage : endMessage,
    `</pty_output>`,
  ].join('\n')
  
  // Wrap in kortix_system tags so frontend renders as system/internal component
  return `<kortix_system type="pty-output" source="opencode-pty">\n${inner}\n</kortix_system>`
}

/**
 * Validates and creates a RegExp from pattern string
 */
function validateAndCreateRegex(pattern: string, ignoreCase?: boolean): RegExp {
  if (!validateRegex(pattern)) {
    throw new Error(
      `Potentially dangerous regex pattern rejected: '${pattern}'. Please use a safer pattern.`
    )
  }

  try {
    return new RegExp(pattern, ignoreCase ? 'i' : '')
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    throw new Error(`Invalid regex pattern '${pattern}': ${error}`)
  }
}

/**
 * Handles pattern-based reading and formatting
 */
function handlePatternRead(
  id: string,
  pattern: string,
  ignoreCase: boolean | undefined,
  session: PTYSessionInfo,
  offset: number,
  limit: number
): string {
  const regex = validateAndCreateRegex(pattern, ignoreCase)

  const result = manager.search(id, regex, offset, limit)
  if (!result) {
    throw buildSessionNotFoundError(id)
  }

  if (result.matches.length === 0) {
    const inner = [
      `<pty_output id="${id}" status="${session.status}" pattern="${pattern}">`,
      `No lines matched the pattern '${pattern}'.`,
      `Total lines in buffer: ${result.totalLines}`,
      `</pty_output>`,
    ].join('\n')
    return `<kortix_system type="pty-output" source="opencode-pty">\n${inner}\n</kortix_system>`
  }

  const formattedLines = result.matches.map((match) =>
    formatLine(match.text, match.lineNumber, MAX_LINE_LENGTH)
  )

  const paginationMessage = `(${result.matches.length} of ${result.totalMatches} matches shown. Use offset=${offset + result.matches.length} to see more.)`
  const endMessage = `(${result.totalMatches} match${result.totalMatches === 1 ? '' : 'es'} from ${result.totalLines} total lines)`

  return formatPtyOutput(
    id,
    session.status,
    pattern,
    formattedLines,
    result.hasMore,
    paginationMessage,
    endMessage
  )
}

/**
 * Handles plain reading and formatting
 */
function handlePlainRead(
  args: ReadArgs,
  session: PTYSessionInfo,
  offset: number,
  limit: number
): string {
  const result = manager.read(args.id, offset, limit)
  if (!result) {
    throw buildSessionNotFoundError(args.id)
  }

  if (result.lines.length === 0) {
    const inner = [
      `<pty_output id="${args.id}" status="${session.status}">`,
      `(No output available - buffer is empty)`,
      `Total lines: ${result.totalLines}`,
      `</pty_output>`,
    ].join('\n')
    return `<kortix_system type="pty-output" source="opencode-pty">\n${inner}\n</kortix_system>`
  }

  const formattedLines = result.lines.map((line, index) =>
    formatLine(line, result.offset + index + 1, MAX_LINE_LENGTH)
  )

  const paginationMessage = `(Buffer has more lines. Use offset=${result.offset + result.lines.length} to read beyond line ${result.offset + result.lines.length})`
  const endMessage = `(End of buffer - total ${result.totalLines} lines)`

  return formatPtyOutput(
    args.id,
    session.status,
    undefined,
    formattedLines,
    result.hasMore,
    paginationMessage,
    endMessage
  )
}

/**
 * Formats a single line with line number and truncation
 */
function validateRegex(pattern: string): boolean {
  try {
    new RegExp(pattern)
    // Check for potentially dangerous patterns that can cause exponential backtracking
    // This is a basic check - more sophisticated validation could be added
    const dangerousPatterns = [
      /\(\?:.*\)\*.*\(\?:.*\)\*/, // nested optional groups with repetition
      /.*\(\.\*\?\)\{2,\}.*/, // overlapping non-greedy quantifiers
      /.*\(.*\|.*\)\{3,\}.*/, // complex alternation with repetition
    ]
    return !dangerousPatterns.some((dangerous) => dangerous.test(pattern))
  } catch {
    return false
  }
}

export const ptyRead = tool({
  description: DESCRIPTION,
  args: {
    id: tool.schema.string().describe('The PTY session ID (e.g., pty_a1b2c3d4)'),
    offset: tool.schema
      .number()
      .optional()
      .describe(
        'Line number to start reading from (0-based, defaults to 0). When using pattern, this applies to filtered matches.'
      ),
    limit: tool.schema
      .number()
      .optional()
      .describe(
        'Number of lines to read (defaults to 500). When using pattern, this applies to filtered matches.'
      ),
    pattern: tool.schema
      .string()
      .optional()
      .describe(
        'Regex pattern to filter lines. When set, only matching lines are returned, then offset/limit apply to the matches.'
      ),
    ignoreCase: tool.schema
      .boolean()
      .optional()
      .describe('Case-insensitive pattern matching (default: false)'),
  },
  async execute(args) {
    const session = manager.get(args.id)
    if (!session) {
      throw buildSessionNotFoundError(args.id)
    }

    const offset = args.offset ?? 0
    const limit = args.limit ?? DEFAULT_READ_LIMIT

    if (args.pattern) {
      return handlePatternRead(args.id, args.pattern, args.ignoreCase, session, offset, limit)
    } else {
      return handlePlainRead(args, session, offset, limit)
    }
  },
})
