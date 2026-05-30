import type { PTYSession } from './types.ts'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { NOTIFICATION_LINE_TRUNCATE, NOTIFICATION_TITLE_TRUNCATE } from '../constants.ts'

export class NotificationManager {
  private client: OpencodeClient | null = null

  init(client: OpencodeClient): void {
    this.client = client
  }

  async sendExitNotification(session: PTYSession, exitCode: number): Promise<void> {
    if (!this.client) {
      return
    }

    try {
      const message = this.buildExitNotification(session, exitCode)
      await this.client.session.promptAsync({
        path: { id: session.parentSessionId },
        body: {
          parts: [{ type: 'text', text: message }],
          ...(session.parentAgent ? { agent: session.parentAgent } : {}),
        },
      })
    } catch {
      // Ignore notification errors
    }
  }

  private buildExitNotification(session: PTYSession, exitCode: number): string {
    const lineCount = session.buffer.length
    let lastLine = ''
    if (lineCount > 0) {
      for (let i = lineCount - 1; i >= 0; i--) {
        const bufferLines = session.buffer.read(i, 1)
        const line = bufferLines[0]
        if (line !== undefined && line.trim() !== '') {
          lastLine =
            line.length > NOTIFICATION_LINE_TRUNCATE
              ? `${line.slice(0, NOTIFICATION_LINE_TRUNCATE)}...`
              : line
          break
        }
      }
    }

    const displayTitle = session.description ?? session.title
    const truncatedTitle =
      displayTitle.length > NOTIFICATION_TITLE_TRUNCATE
        ? `${displayTitle.slice(0, NOTIFICATION_TITLE_TRUNCATE)}...`
        : displayTitle

    const hint = exitCode === 0
      ? 'Use pty_read to check the full output.'
      : 'Process failed. Use pty_read with the pattern parameter to search for errors in the output.'

    const lines = [
      '<pty_exited>',
      `ID: ${session.id}`,
      `Description: ${truncatedTitle}`,
      `Exit Code: ${exitCode}`,
      `Output Lines: ${lineCount}`,
      `Last Line: ${lastLine}`,
      `Hint: ${hint}`,
      '</pty_exited>',
    ]

    return lines.join('\n')
  }
}
