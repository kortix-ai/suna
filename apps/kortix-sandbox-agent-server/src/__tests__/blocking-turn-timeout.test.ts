/**
 * The daemon must not abort a turn that is still being computed.
 *
 * opencode withholds the response to `POST /session/:id/message` and
 * `POST /session/:id/command` until the ENTIRE reasoning + tool-call turn is
 * done. The proxy bounded every upstream wait at 10s, so any command longer
 * than that got aborted and answered `502 {"error":"upstream unreachable"}` —
 * the banner users saw in chat.
 *
 * It got worse downstream: that 502 is exactly the signal apps/api's retry loop
 * was built to act on, so a fail-fast meant to trigger a retry met a retry loop
 * that assumed idempotency. One session recorded one `/webapp` submit as
 * four identical user messages ~10.75s apart (the 10s bound plus apps/api's
 * [250, 1000, 3000] delays), each retry aborting the turn the last one started.
 */
import { describe, expect, test } from 'bun:test'

// The daemon sits INSIDE the sandbox and cannot import from apps/api, so the
// predicate is duplicated there. This test file may import it: a drift means
// the inner layer aborts what the outer one is patiently waiting for —
// silently, as a 502 that looks like a dead sandbox.
import { isLongTurnCompletionRequest } from '../../../api/src/sandbox-proxy/preview-retry-budget'
import { isBlockingTurnRequest } from '../harness/open-code/proxy'

// Production passes `url.pathname` only, so no row carries a query string.
const ROWS: Array<[method: string, path: string, blocking: boolean]> = [
  // opencode withholds these responses until the whole turn is done.
  ['POST', '/session/ses_abc/message', true],
  // /command: the omission that produced "upstream unreachable".
  ['POST', '/session/ses_abc/command', true],
  ['post', '/session/ses_abc/command', true],
  // /summarize: same omission one endpoint over (every /compact died at 10 s).
  ['POST', '/session/ses_abc/summarize', true],
  ['post', '/session/ses_abc/summarize', true],
  ['GET', '/session/ses_abc/summarize', false],
  // `prompt_async` answers at once and streams over /global/event, so a 10 s
  // silence there really does mean opencode is wedged.
  ['POST', '/session/ses_abc/prompt_async', false],
  // SSE and reads keep the short bound.
  ['GET', '/global/event', false],
  ['GET', '/session/ses_abc/message', false],
  // Lookalike paths.
  ['POST', '/session/ses_abc/summarizes', false],
  ['POST', '/session/ses_abc/commands', false],
  ['POST', '/session/ses_abc/messages', false],
  ['POST', '/not-session/ses_abc/command', false],
]

describe('which upstream calls may outlive the short proxy bound', () => {
  test.each(ROWS)('%s %s blocks for the whole turn: %p', (method, path, blocking) => {
    expect(isBlockingTurnRequest(method, path)).toBe(blocking)
  })

  test.each(ROWS)('apps/api agrees on %s %s', (method, path) => {
    expect(isLongTurnCompletionRequest({ method, path })).toBe(isBlockingTurnRequest(method, path))
  })
})
