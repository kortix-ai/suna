/**
 * A runtime `permission.asked` reaches apps/api so the session creator gets a
 * "needs your approval" push. The relay only REPORTS: it never replies to or
 * resolves the permission, and a failed report never throws.
 *
 * One fake server plays apps/api, so each test asserts the real requests the
 * relay sends.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import type { RuntimePermissionRequest as PermissionRequest } from '@kortix/api-contract/transcript'
import { relayPermission } from '@/harness/shared/turn-relay'

type Recorded = { method: string; path: string; auth: string | null; body: any }

let server: ReturnType<typeof Bun.serve>
let requests: Recorded[] = []
let status = 200

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
      return Response.json({ ok: status === 200, live_wait_ms: 0, approved: true, grant: 'bash' }, { status })
    },
  })
})

afterAll(() => {
  server.stop(true)
})

const CONTROL_KEYS = ['KORTIX_PROJECT_ID', 'KORTIX_SESSION_ID', 'KORTIX_TOKEN', 'KORTIX_API_URL'] as const
const saved = new Map<string, string | undefined>()

beforeEach(() => {
  requests = []
  status = 200
  for (const key of CONTROL_KEYS) saved.set(key, process.env[key])
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

const REQUEST: PermissionRequest = {
  id: 'per_1',
  sessionID: 'ses_root',
  permission: 'bash',
  patterns: ['git push *'],
  metadata: { command: 'git push origin main' },
  always: ['git push *'],
  tool: { messageID: 'msg_1', callID: 'call_1' },
}

describe('relayPermission', () => {
  test('posts the permission, its tool and argument hash, and reads how to wait', async () => {
    const answer = await relayPermission(REQUEST, { tool: 'bash', argsHash: 'hash-1' })

    expect(requests).toHaveLength(1)
    expect(requests[0]!.method).toBe('POST')
    expect(requests[0]!.path).toBe('/v1/workspaces/proj-1/turn-permission')
    expect(requests[0]!.auth).toBe('Bearer sandbox-token')
    expect(requests[0]!.body).toEqual({
      session_id: 'sess-1',
      request_id: 'per_1',
      runtime_session_id: 'ses_root',
      permission: 'bash',
      patterns: ['git push *'],
      tool: 'bash',
      args_hash: 'hash-1',
      args: { command: 'git push origin main' },
    })
    expect(answer).toEqual({ liveWaitMs: 0, approved: true, grant: 'bash' })
    expect(requests.some((r) => r.path.startsWith('/permission'))).toBe(false)
  })

  test('arguments above the relay cap arrive as a preview', async () => {
    await relayPermission({ ...REQUEST, metadata: { content: 'x'.repeat(40_000) } }, { tool: 'write', argsHash: 'hash-2' })
    const args = requests[0]!.body.args as { truncated: boolean; preview: string }
    expect(args.truncated).toBe(true)
    expect(args.preview.length).toBe(2_000)
  })

  test('a non-2xx response is swallowed', async () => {
    status = 500
    await expect(relayPermission(REQUEST)).resolves.toBeNull()
    expect(requests).toHaveLength(1)
  })

  test('an unreachable API is swallowed', async () => {
    process.env.KORTIX_API_URL = 'http://127.0.0.1:1'
    await expect(relayPermission(REQUEST)).resolves.toBeNull()
    expect(requests).toHaveLength(0)
  })

  test('without a control plane nothing is sent', async () => {
    delete process.env.KORTIX_API_URL
    await relayPermission(REQUEST)
    expect(requests).toHaveLength(0)
  })
})
