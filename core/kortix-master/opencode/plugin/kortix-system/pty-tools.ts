import { type Plugin, tool } from '@opencode-ai/plugin'
import { DEFAULT_READ_LIMIT, MAX_LINE_LENGTH } from './pty/opencode-pty/src/shared/constants.ts'
import { formatLine, formatSessionInfo } from './pty/opencode-pty/src/plugin/pty/formatters.ts'
import { initPermissions, checkCommandPermission, checkWorkdirPermission } from './pty/opencode-pty/src/plugin/pty/permissions.ts'
import { initManager, manager } from './pty/opencode-pty/src/plugin/pty/manager.ts'

const ETX = String.fromCharCode(3)
const EOT = String.fromCharCode(4)

function notFound(id: string): Error {
  return new Error(`PTY session '${id}' not found. Use pty_list to see active sessions.`)
}

function parseEscapeSequences(input: string): string {
  return input.replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|[nrt\\])/g, (match, seq: string) => {
    if (seq.startsWith('x')) return String.fromCharCode(parseInt(seq.slice(1), 16))
    if (seq.startsWith('u')) return String.fromCharCode(parseInt(seq.slice(1), 16))
    switch (seq) {
      case 'n': return '\n'
      case 'r': return '\r'
      case 't': return '\t'
      case '\\': return '\\'
      default: return match
    }
  })
}

function extractCommands(data: string): string[] {
  return data
    .split(/[\n\r]+/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(ETX) && !line.startsWith(EOT))
}

function parseCommand(commandLine: string): { command: string; args: string[] } {
  const parts = commandLine.split(/\s+/).filter(Boolean)
  return { command: parts[0] ?? '', args: parts.slice(1) }
}

function validateRegex(pattern: string): boolean {
  try {
    new RegExp(pattern)
    const dangerousPatterns = [
      /\(\?:.*\)\*.*\(\?:.*\)\*/,
      /.*\(\.\*\?\)\{2,\}.*/,
      /.*\(.*\|.*\)\{3,\}.*/,
    ]
    return !dangerousPatterns.some((dangerous) => dangerous.test(pattern))
  } catch {
    return false
  }
}

function buildPtyOutput(
  id: string,
  status: string,
  lines: string[],
  footer: string,
  pattern?: string,
): string {
  const inner = [
    `<pty_output id="${id}" status="${status}"${pattern ? ` pattern="${pattern}"` : ''}>`,
    ...lines,
    '',
    footer,
    `</pty_output>`,
  ].join('\n')
  return `<kortix_system type="pty-output" source="opencode-pty">\n${inner}\n</kortix_system>`
}

const PtyToolsPlugin: Plugin = async ({ client, directory, serverUrl }) => {
  console.log('[pty-tools] plugin init')
  initPermissions(client, directory)
  initManager(client, serverUrl, directory)
  manager.probe().catch(() => undefined)

  return {
    tool: {
      pty_spawn: tool({
        description: 'Spawn a background PTY session for a long-running or interactive command.',
        args: {
          command: tool.schema.string().describe('Command/executable to run'),
          args: tool.schema.array(tool.schema.string()).optional().describe('Arguments to pass to the command'),
          workdir: tool.schema.string().optional().describe('Working directory for the PTY session'),
          env: tool.schema.object({}).catchall(tool.schema.string()).optional().describe('Additional environment variables'),
          title: tool.schema.string().optional().describe('Human-readable title for the session'),
          description: tool.schema.string().describe('Clear, concise 5-10 word description'),
          notifyOnExit: tool.schema.boolean().optional().describe('Notify when the process exits'),
        },
        async execute(args, ctx) {
          await checkCommandPermission(args.command, args.args ?? [])
          if (args.workdir) await checkWorkdirPermission(args.workdir)
          const info = await manager.spawn({
            command: args.command,
            args: args.args,
            workdir: args.workdir,
            env: args.env,
            title: args.title,
            description: args.description,
            parentSessionId: ctx.sessionID,
            parentAgent: ctx.agent,
            notifyOnExit: args.notifyOnExit,
          })
          const inner = [
            'ID: ' + info.id,
            'Title: ' + info.title,
            `Command: ${info.command} ${info.args.join(' ')}`,
            'Workdir: ' + info.workdir,
            'PID: ' + info.pid,
            'Status: ' + info.status,
          ].join('\n')
          return `<kortix_system type="pty-spawn" source="opencode-pty">\n<pty_spawned>\n${inner}\n</pty_spawned>\n</kortix_system>`
        },
      }),

      pty_write: tool({
        description: 'Send input to a running PTY session.',
        args: {
          id: tool.schema.string().describe('PTY session ID'),
          data: tool.schema.string().describe('Input data to send to the PTY'),
        },
        async execute(args) {
          const session = manager.get(args.id)
          if (!session) throw notFound(args.id)
          if (session.status !== 'running') {
            throw new Error(`Cannot write to PTY '${args.id}' - session status is '${session.status}'.`)
          }
          const parsedData = parseEscapeSequences(args.data)
          for (const commandLine of extractCommands(parsedData)) {
            const { command, args: cmdArgs } = parseCommand(commandLine)
            if (command) await checkCommandPermission(command, cmdArgs)
          }
          const success = await manager.write(args.id, parsedData)
          if (!success) throw new Error(`Failed to write to PTY '${args.id}'.`)
          const preview = args.data.length > 50 ? `${args.data.slice(0, 50)}...` : args.data
          const displayPreview = preview
            .replace(new RegExp(ETX, 'g'), '^C')
            .replace(new RegExp(EOT, 'g'), '^D')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
          return `<kortix_system type="pty-write" source="opencode-pty">\nSent ${args.data.length} bytes to ${args.id}: "${displayPreview}"\n</kortix_system>`
        },
      }),

      pty_read: tool({
        description: 'Read PTY output with pagination and optional regex filtering.',
        args: {
          id: tool.schema.string().describe('PTY session ID'),
          offset: tool.schema.number().optional().describe('0-based starting line/match offset'),
          limit: tool.schema.number().optional().describe('Maximum number of lines/matches to return'),
          pattern: tool.schema.string().optional().describe('Regex filter applied before pagination'),
          ignoreCase: tool.schema.boolean().optional().describe('Case-insensitive regex matching'),
        },
        async execute(args) {
          const session = manager.get(args.id)
          if (!session) throw notFound(args.id)
          const offset = args.offset ?? 0
          const limit = args.limit ?? DEFAULT_READ_LIMIT

          if (args.pattern) {
            if (!validateRegex(args.pattern)) {
              throw new Error(`Potentially dangerous regex pattern rejected: '${args.pattern}'. Please use a safer pattern.`)
            }
            const regex = new RegExp(args.pattern, args.ignoreCase ? 'i' : '')
            const result = manager.search(args.id, regex, offset, limit)
            if (!result) throw notFound(args.id)
            if (result.matches.length === 0) {
              return `<kortix_system type="pty-output" source="opencode-pty">\n<pty_output id="${args.id}" status="${session.status}" pattern="${args.pattern}">\nNo lines matched the pattern '${args.pattern}'.\nTotal lines in buffer: ${result.totalLines}\n</pty_output>\n</kortix_system>`
            }
            const lines = result.matches.map((match) => formatLine(match.text, match.lineNumber, MAX_LINE_LENGTH))
            const footer = result.hasMore
              ? `(${result.matches.length} of ${result.totalMatches} matches shown. Use offset=${offset + result.matches.length} to see more.)`
              : `(${result.totalMatches} match${result.totalMatches === 1 ? '' : 'es'} from ${result.totalLines} total lines)`
            return buildPtyOutput(args.id, session.status, lines, footer, args.pattern)
          }

          const result = manager.read(args.id, offset, limit)
          if (!result) throw notFound(args.id)
          if (result.lines.length === 0) {
            return `<kortix_system type="pty-output" source="opencode-pty">\n<pty_output id="${args.id}" status="${session.status}">\n(No output available - buffer is empty)\nTotal lines: ${result.totalLines}\n</pty_output>\n</kortix_system>`
          }
          const lines = result.lines.map((line, index) => formatLine(line, result.offset + index + 1, MAX_LINE_LENGTH))
          const footer = result.hasMore
            ? `(Buffer has more lines. Use offset=${result.offset + result.lines.length} to read beyond line ${result.offset + result.lines.length})`
            : `(End of buffer - total ${result.totalLines} lines)`
          return buildPtyOutput(args.id, session.status, lines, footer)
        },
      }),

      pty_list: tool({
        description: 'List active PTY sessions.',
        args: {},
        async execute() {
          const sessions = await manager.list()
          if (sessions.length === 0) {
            return `<kortix_system type="pty-list" source="opencode-pty">\n<pty_list>\nNo active PTY sessions.\n</pty_list>\n</kortix_system>`
          }
          const inner = ['<pty_list>', ...sessions.flatMap((session) => formatSessionInfo(session)), `Total: ${sessions.length} session(s)`, '</pty_list>'].join('\n')
          return `<kortix_system type="pty-list" source="opencode-pty">\n${inner}\n</kortix_system>`
        },
      }),

      pty_kill: tool({
        description: 'Terminate a PTY session and optionally clean it up.',
        args: {
          id: tool.schema.string().describe('PTY session ID'),
          cleanup: tool.schema.boolean().optional().describe('If true, remove the cached session data too'),
        },
        async execute(args) {
          const session = manager.get(args.id)
          if (!session) throw notFound(args.id)
          const wasRunning = session.status === 'running'
          const cleanup = args.cleanup ?? false
          const success = await manager.kill(args.id, cleanup)
          if (!success) throw new Error(`Failed to kill PTY session '${args.id}'.`)
          const action = wasRunning ? 'Killed' : 'Cleaned up'
          const cleanupNote = cleanup ? ' (session removed)' : ' (session retained for log access)'
          const inner = [
            '<pty_killed>',
            `${action}: ${args.id}${cleanupNote}`,
            `Title: ${session.title}`,
            `Command: ${session.command} ${session.args.join(' ')}`,
            `Final line count: ${session.lineCount}`,
            '</pty_killed>',
          ].join('\n')
          return `<kortix_system type="pty-kill" source="opencode-pty">\n${inner}\n</kortix_system>`
        },
      }),
    },
    event: async ({ event }) => {
      if (event.type === 'session.deleted') manager.cleanupBySession(event.properties.info.id)
    },
  }
}

export default PtyToolsPlugin
