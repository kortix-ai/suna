import { tool } from '@opencode-ai/plugin'
import { manager } from '../manager.ts'
import { formatSessionInfo } from '../formatters.ts'
import DESCRIPTION from './list.txt'

export const ptyList = tool({
  description: DESCRIPTION,
  args: {},
  async execute() {
    const sessions = await manager.list()

    if (sessions.length === 0) {
      const inner = '<pty_list>\nNo active PTY sessions.\n</pty_list>'
      return `<kortix_system type="pty-list" source="opencode-pty">\n${inner}\n</kortix_system>`
    }

    const lines = ['<pty_list>']
    for (const session of sessions) {
      lines.push(...formatSessionInfo(session))
    }
    lines.push(`Total: ${sessions.length} session(s)`)
    lines.push('</pty_list>')
    
    const inner = lines.join('\n')
    return `<kortix_system type="pty-list" source="opencode-pty">\n${inner}\n</kortix_system>`
  },
})
