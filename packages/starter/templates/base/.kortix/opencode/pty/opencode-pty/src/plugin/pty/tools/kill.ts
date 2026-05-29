import { tool } from '@opencode-ai/plugin'
import { manager } from '../manager.ts'
import { buildSessionNotFoundError } from '../utils.ts'
import DESCRIPTION from './kill.txt'

export const ptyKill = tool({
  description: DESCRIPTION,
  args: {
    id: tool.schema.string().describe('The PTY session ID (e.g., pty_a1b2c3d4)'),
    cleanup: tool.schema
      .boolean()
      .optional()
      .describe('If true, removes the session and frees the buffer (default: false)'),
  },
  async execute(args) {
    const session = manager.get(args.id)
    if (!session) {
      throw buildSessionNotFoundError(args.id)
    }

    const wasRunning = session.status === 'running'
    const cleanup = args.cleanup ?? false
    const success = await manager.kill(args.id, cleanup)

    if (!success) {
      throw new Error(`Failed to kill PTY session '${args.id}'.`)
    }

    const action = wasRunning ? 'Killed' : 'Cleaned up'
    const cleanupNote = cleanup ? ' (session removed)' : ' (session retained for log access)'

    const inner = [
      `<pty_killed>`,
      `${action}: ${args.id}${cleanupNote}`,
      `Title: ${session.title}`,
      `Command: ${session.command} ${session.args.join(' ')}`,
      `Final line count: ${session.lineCount}`,
      `</pty_killed>`,
    ].join('\n')
    
    return `<kortix_system type="pty-kill" source="opencode-pty">\n${inner}\n</kortix_system>`
  },
})
