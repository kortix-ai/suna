/**
 * Reporting a question and RESOLVING it are separate decisions, for both
 * harness adapters.
 *
 * - Every session REPORTS `question.asked` to apps/api (`POST …/turn-question`),
 *   so the ask is persisted and survives the box being parked.
 * - Only a channel session (Slack or Teams) RELEASES the blocking `question`
 *   call with a sentinel, because only there does the answer arrive out of band.
 *   A dashboard session answers over the runtime's own event stream; a sentinel
 *   there told a web agent "Posted to the Slack thread" (dev, 2026-08-05) and
 *   talked it out of the tool.
 * - A Teams session is a channel. Reading only the Slack keys once left every
 *   Teams question blocked until the box parked.
 *
 * One fake server plays apps/api and OpenCode, so each row asserts the real
 * requests the adapter sends.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import type { OpenCodeConfig } from '../harness/open-code/config'
import { relayQuestionToApi } from '../harness/open-code/question-relay'
import { relayQuestion } from '../harness/pi/relay'

type Recorded = { method: string; path: string; search: string; auth: string | null; body: any }

let server: ReturnType<typeof Bun.serve>
let requests: Recorded[] = []

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const text = await req.text()
      requests.push({
        method: req.method,
        path: url.pathname,
        search: url.search,
        auth: req.headers.get('authorization'),
        body: text ? JSON.parse(text) : null,
      })
      return Response.json(true)
    },
  })
})

afterAll(() => {
  server.stop(true)
})

const CHANNEL_KEYS = ['SLACK_THREAD_TS', 'SLACK_CHANNEL_ID', 'MS_TEAMS_CONVERSATION_ID', 'MS_TEAMS_TENANT_ID'] as const
const CONTROL_KEYS = ['KORTIX_PROJECT_ID', 'KORTIX_SESSION_ID', 'KORTIX_TOKEN', 'KORTIX_API_URL'] as const
const saved = new Map<string, string | undefined>()

beforeEach(() => {
  requests = []
  for (const key of [...CHANNEL_KEYS, ...CONTROL_KEYS]) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  process.env.KORTIX_PROJECT_ID = 'proj-1'
  process.env.KORTIX_SESSION_ID = 'sess-1'
  process.env.KORTIX_TOKEN = 'sandbox-token'
  process.env.KORTIX_API_URL = `http://127.0.0.1:${server.port}`
})

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const REQUEST = {
  id: 'que_1',
  sessionID: 'ses_root',
  questions: [
    { question: 'Which branch?', header: 'Branch', options: [{ value: 'main' }] },
    { question: 'Ship it?', header: 'Ship', options: [{ value: 'yes' }, { value: 'no' }] },
  ],
}

// Each row: the env a session carries, and the channel it must be read as.
const ROWS: Array<[string, Record<string, string>, 'Slack' | 'Teams' | null]> = [
  ['dashboard (no channel env)', {}, null],
  ['Slack thread', { SLACK_THREAD_TS: '1700000000.000100' }, 'Slack'],
  ['Slack channel', { SLACK_CHANNEL_ID: 'C0000TEST' }, 'Slack'],
  ['Teams conversation', { MS_TEAMS_CONVERSATION_ID: 'conv-test' }, 'Teams'],
  ['Teams tenant', { MS_TEAMS_TENANT_ID: 'tenant-test' }, 'Teams'],
]

describe('OpenCode adapter: relayQuestionToApi', () => {
  const opencode = { getInternalUrl: () => `http://127.0.0.1:${server.port}` }
  const cfg = { workspace: '/work space' } as OpenCodeConfig

  test.each(ROWS)('%s: reports the question; releases it only in a channel', async (_name, env, channel) => {
    Object.assign(process.env, env)

    await relayQuestionToApi(REQUEST, cfg, opencode)

    const reported = requests.filter((r) => r.path === '/v1/projects/proj-1/turn-question')
    expect(reported).toHaveLength(1)
    expect(reported[0]!.auth).toBe('Bearer sandbox-token')
    expect(reported[0]!.body).toEqual({
      session_id: 'sess-1',
      request_id: 'que_1',
      opencode_session_id: 'ses_root',
      questions: REQUEST.questions,
    })

    const replies = requests.filter((r) => r.path === '/question/que_1/reply')
    if (channel === null) {
      expect(replies).toHaveLength(0)
      return
    }
    expect(replies).toHaveLength(1)
    expect(replies[0]!.search).toBe('?directory=%2Fwork%20space')
    const answers = replies[0]!.body.answers as string[][]
    expect(answers).toHaveLength(REQUEST.questions.length)
    expect(answers[0]![0]).toContain(`Posted to the ${channel} conversation`)
    expect(answers[0]![0]).not.toContain(channel === 'Teams' ? 'Slack' : 'Teams')
  })

  test('without a control plane nothing is reported or released', async () => {
    delete process.env.KORTIX_API_URL
    process.env.SLACK_THREAD_TS = '1700000000.000100'

    await relayQuestionToApi(REQUEST, cfg, opencode)

    expect(requests).toHaveLength(0)
  })
})

describe('pi adapter: relayQuestion', () => {
  test.each(ROWS)('%s: reports the question; answers it only in a channel', async (_name, env, channel) => {
    Object.assign(process.env, env)
    const answered: string[][][] = []

    await relayQuestion(REQUEST, (answers) => answered.push(answers))

    const reported = requests.filter((r) => r.path === '/v1/projects/proj-1/turn-question')
    expect(reported).toHaveLength(1)
    expect(reported[0]!.auth).toBe('Bearer sandbox-token')
    expect(reported[0]!.body).toMatchObject({ session_id: 'sess-1', request_id: 'que_1', opencode_session_id: 'ses_root' })

    if (channel === null) {
      expect(answered).toHaveLength(0)
      return
    }
    expect(answered).toHaveLength(1)
    const sentinel = answered[0]![0]![0]!
    expect(sentinel).toContain(channel === 'Teams' ? 'the Teams conversation' : 'the Slack thread')
    // Both channel prompts tell the agent to USE the question tool.
    expect(sentinel).not.toContain('rather than the question tool')
  })
})
