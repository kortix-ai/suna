import type { RuntimeQuestionRequest } from '@kortix/api-contract/transcript'
import { logger } from '@/lib/log/logger'
import { relayQuestion } from '../shared/turn-relay'
import type { OpenCodeConfig as Config } from './config'
import type { Opencode } from './lifecycle'

/**
 * Relay an OpenCode `question.asked` event to apps/api, and release the
 * blocking `question` tool call only in a channel session.
 *
 * REPORTING is for every session (`relayQuestion`): apps/api persists the
 * question, so an ask survives the box being parked.
 *
 * RESOLVING is channel-only. In a Slack or Teams session the reply arrives out
 * of band as a new turn, so the call must be released with a sentinel or the
 * turn hangs. A dashboard session answers `question.asked` over OpenCode's own
 * SSE, so the call keeps blocking while the box is alive. Auto-answering it
 * there is the "every question is auto-answered even outside Slack" bug: seen
 * on dev 2026-08-05, a web session's agent was told "Posted to the Slack thread"
 * (it was not) and stopped using the `question` tool.
 */
export async function relayQuestionToApi(
  req: RuntimeQuestionRequest,
  cfg: Config,
  opencode: Pick<Opencode, 'getInternalUrl'>,
): Promise<void> {
  const answers = await relayQuestion(req)
  if (!answers) {
    logger.info('[opencode-events] question persisted; left open for the UI', { requestId: req.id })
    return
  }
  const replyUrl = `${opencode.getInternalUrl()}/question/${encodeURIComponent(req.id)}/reply?directory=${encodeURIComponent(cfg.workspace)}`
  try {
    const r = await fetch(replyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) {
      logger.warn('[opencode-events] opencode question.reply non-ok', {
        status: r.status, body: (await r.text()).slice(0, 300),
      })
      return
    }
    logger.info('[opencode-events] question resolved async (sentinel)', { requestId: req.id })
  } catch (err) {
    logger.warn('[opencode-events] opencode question.reply failed', { err: (err as Error).message })
  }
}
