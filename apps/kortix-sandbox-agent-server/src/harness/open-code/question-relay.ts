import { logger } from '../../logger'
import { sandboxRelayContext, sessionChannel } from '../../relay-context'
import type { OpenCodeConfig as Config } from './config'
import type { QuestionRequest } from './events'
import type { Opencode } from './lifecycle'

/**
 * Relay an OpenCode `question.asked` event to apps/api, and release the
 * blocking `question` tool call only in a channel session.
 *
 * REPORTING is for every session. apps/api persists the question regardless of
 * channel, so an ask survives the box being parked: OpenCode restarts cold, and
 * a web session used to come back having silently forgotten what it asked.
 * Posting it into a thread is channel-specific and stays server-side.
 *
 * RESOLVING is channel-only. In a Slack or Teams session the reply arrives out
 * of band as a new turn, so the call must be released with a sentinel or the
 * turn hangs. A dashboard session answers `question.asked` over OpenCode's own
 * SSE, so the call keeps blocking while the box is alive. Auto-answering it
 * there is the "every question is auto-answered even outside Slack" bug: seen
 * on dev 2026-08-05, a web session's agent was told "Posted to the Slack thread"
 * (it was not) and stopped using the `question` tool. If the box is parked
 * while the question is open, apps/api has it and `POST /sessions/:id/question`
 * delivers the answer as a follow-up turn.
 */
export async function relayQuestionToApi(
  req: QuestionRequest,
  cfg: Config,
  opencode: Pick<Opencode, 'getInternalUrl'>,
): Promise<void> {
  const ctx = sandboxRelayContext()
  if (!ctx) return
  const { projectId, sessionId, token, apiRoot } = ctx
  const url = `${apiRoot}/projects/${encodeURIComponent(projectId)}/turn-question`
  logger.info('[opencode-events] relaying question.asked', {
    requestId: req.id, questions: req.questions.length,
  })

  // Best-effort: render the question(s) into the thread. Independent of the
  // release below — a channel turn must never hang waiting on this.
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        session_id: sessionId,
        request_id: req.id,
        opencode_session_id: req.sessionID,
        questions: req.questions,
      }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    logger.warn('[opencode-events] turn-question post failed (non-fatal)', { err: (err as Error).message })
  }

  const channel = sessionChannel()
  if (!channel) {
    logger.info('[opencode-events] question persisted; left open for the UI', {
      requestId: req.id,
    })
    return
  }

  // Name the channel the agent is actually in. The old text said "Slack" and
  // "`slack send`" unconditionally, which in a Teams conversation instructed
  // the agent to use a CLI it does not have.
  const sentinel =
    `(Posted to the ${channel} conversation. In ${channel}, questions are async — the user ` +
    'replies as a normal message, which reaches you as a NEW turn with full context. Do NOT ' +
    'wait for an answer here; finish this turn now.)'
  const answers: string[][] = req.questions.map(() => [sentinel])
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
