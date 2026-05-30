import { tool } from '@opencode-ai/plugin'
import { manager } from '../manager.ts'
import { checkCommandPermission } from '../permissions.ts'
import { buildSessionNotFoundError } from '../utils.ts'
import DESCRIPTION from './write.txt'

const ETX = String.fromCharCode(3)
const EOT = String.fromCharCode(4)

/**
 * Parse escape sequences in a string to their actual byte values.
 * Handles: \n, \r, \t, \xNN (hex), \uNNNN (unicode), \\
 */
function parseEscapeSequences(input: string): string {
  return input.replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|[nrt\\])/g, (match, seq: string) => {
    if (seq.startsWith('x')) {
      return String.fromCharCode(parseInt(seq.slice(1), 16))
    }
    if (seq.startsWith('u')) {
      return String.fromCharCode(parseInt(seq.slice(1), 16))
    }
    switch (seq) {
      case 'n':
        return '\n'
      case 'r':
        return '\r'
      case 't':
        return '\t'
      case '\\':
        return '\\'
      default:
        return match
    }
  })
}

function extractCommands(data: string): string[] {
  const commands: string[] = []
  const lines = data.split(/[\n\r]+/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith(ETX) && !trimmed.startsWith(EOT)) {
      commands.push(trimmed)
    }
  }
  return commands
}

function parseCommand(commandLine: string): { command: string; args: string[] } {
  const parts = commandLine.split(/\s+/).filter(Boolean)
  const command = parts[0] ?? ''
  const args = parts.slice(1)
  return { command, args }
}

export const ptyWrite = tool({
  description: DESCRIPTION,
  args: {
    id: tool.schema.string().describe('The PTY session ID (e.g., pty_a1b2c3d4)'),
    data: tool.schema.string().describe('The input data to send to the PTY'),
  },
  async execute(args) {
    const session = manager.get(args.id)
    if (!session) {
      throw buildSessionNotFoundError(args.id)
    }

    if (session.status !== 'running') {
      throw new Error(`Cannot write to PTY '${args.id}' - session status is '${session.status}'.`)
    }

    // Parse escape sequences to actual bytes
    const parsedData = parseEscapeSequences(args.data)

    const commands = extractCommands(parsedData)
    for (const commandLine of commands) {
      const { command, args: cmdArgs } = parseCommand(commandLine)
      if (command) {
        await checkCommandPermission(command, cmdArgs)
      }
    }

    const success = await manager.write(args.id, parsedData)
    if (!success) {
      throw new Error(`Failed to write to PTY '${args.id}'.`)
    }

    const preview = args.data.length > 50 ? `${args.data.slice(0, 50)}...` : args.data
    const displayPreview = preview
      .replace(new RegExp(ETX, 'g'), '^C')
      .replace(new RegExp(EOT, 'g'), '^D')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
    
    const inner = `Sent ${args.data.length} bytes to ${args.id}: "${displayPreview}"`
    return `<kortix_system type="pty-write" source="opencode-pty">\n${inner}\n</kortix_system>`
  },
})
