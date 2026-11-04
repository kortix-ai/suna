/**
 * Reporting a question and RESOLVING it are separate decisions.
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
 * One fake server plays apps/api, so each row asserts the real requests the
 * relay sends.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { relayQuestion } from '@/harness/shared/turn-relay'

type Recorded = { method: string; path: string; auth: string | null; body: any }

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
    { question: 'Which branch?', header: 'Branch', options: [{ label: 'main', description: '' }] },
    { question: 'Ship it?', header: 'Ship', options: [{ label: 'yes', description: '' }, { label: 'no', description: '' }] },
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

describe('shared relay (pi calls it directly): relayQuestion', () => {
  test.each(ROWS)('%s: reports the question; answers it only in a channel', async (_name, env, channel) => {
    Object.assign(process.env, env)

    const answers = await relayQuestion(REQUEST)

    const reported = requests.filter((r) => r.path === '/v1/projects/proj-1/turn-question')
    expect(reported).toHaveLength(1)
    expect(reported[0]!.auth).toBe('Bearer sandbox-token')
    expect(reported[0]!.body).toMatchObject({ session_id: 'sess-1', request_id: 'que_1', runtime_session_id: 'ses_root' })
    // Kortix names only: the pre-W3 field is gone from the wire.
    expect(reported[0]!.body).not.toHaveProperty('opencode_session_id')

    if (channel === null) {
      expect(answers).toBeNull()
      return
    }
    expect(answers).toHaveLength(REQUEST.questions.length)
    const sentinel = answers![0]![0]!
    expect(sentinel).toContain(`Posted to the ${channel} conversation`)
    // Both channel prompts tell the agent to USE the question tool.
    expect(sentinel).not.toContain('rather than the question tool')
  })
})
