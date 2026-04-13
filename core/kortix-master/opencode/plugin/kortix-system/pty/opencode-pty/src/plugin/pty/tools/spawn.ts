import { tool } from '@opencode-ai/plugin'
import { manager } from '../manager.ts'
import { checkCommandPermission, checkWorkdirPermission } from '../permissions.ts'
import DESCRIPTION from './spawn.txt'

export const ptySpawn = tool({
  description: DESCRIPTION,
  args: {
    command: tool.schema.string().describe('The command/executable to run'),
    args: tool.schema.array(tool.schema.string()).describe('Arguments to pass to the command'),
    workdir: tool.schema.string().optional().describe('Working directory for the PTY session'),
    env: tool.schema
      .record(tool.schema.string(), tool.schema.string())
      .optional()
      .describe('Additional environment variables'),
    title: tool.schema.string().optional().describe('Human-readable title for the session'),
    description: tool.schema
      .string()
      .describe('Clear, concise description of what this PTY session is for in 5-10 words'),
    notifyOnExit: tool.schema
      .boolean()
      .optional()
      .describe(
        'If true, sends a notification to the session when the process exits (default: false)'
      ),
  },
  async execute(args, ctx) {
    try {
      await checkCommandPermission(args.command, args.args ?? [])

      if (args.workdir) {
        await checkWorkdirPermission(args.workdir)
      }

      const sessionId = ctx.sessionID
      const info = await manager.spawn({
        command: args.command,
        args: args.args,
        workdir: args.workdir,
        env: args.env,
        title: args.title,
        description: args.description,
        parentSessionId: sessionId,
        parentAgent: ctx.agent,
        notifyOnExit: args.notifyOnExit,
      })

      const inner = [
        `ID: ${info.id}`,
        `Title: ${info.title}`,
        `Command: ${info.command} ${info.args.join(' ')}`,
        `Workdir: ${info.workdir}`,
        `PID: ${info.pid}`,
        `Status: ${info.status}`,
      ].join('\n')

      // Wrap in kortix_system tags so frontend renders as system/internal component
      return `<kortix_system type="pty-spawn" source="opencode-pty">\n<pty_spawned>\n${inner}\n</pty_spawned>\n</kortix_system>`
    } catch (err: unknown) {
      // Re-throw permission errors as-is (they have good messages already)
      if (err instanceof Error && err.message.includes('PTY spawn denied')) {
        throw err
      }
      // Re-throw our own diagnostics as-is
      if (err instanceof Error && err.message.includes('[PTY spawn')) {
        throw err
      }

      // Wrap unexpected errors with context
      const msg = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? err.stack : undefined
      throw new Error(
        [
          `[pty_spawn] Failed to spawn PTY session.`,
          `  Command: ${args.command} ${(args.args ?? []).join(' ')}`,
          `  Workdir: ${args.workdir ?? '(default)'}`,
          `  Error: ${msg}`,
          stack ? `  Stack: ${stack.split('\n').slice(1, 4).join('\n    ')}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      )
    }
  },
})
