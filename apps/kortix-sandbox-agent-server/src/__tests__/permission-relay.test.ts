/**
 * OpenCode `permission.asked` reaches apps/api so the session creator gets a
 * "needs your approval" push. The relay only REPORTS: it never replies to or
 * resolves the permission, and a failed report never throws.
 *
 * One fake server plays apps/api and OpenCode, so each test asserts the real
 * requests the adapter sends.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { dispatch, type PermissionRequest } from '../harness/open-code/events'
import { relayPermissionToApi } from '../harness/open-code/permission-relay'

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
      return Response.json({ ok: status === 200 }, { status })
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

describe('relayPermissionToApi', () => {
  test('posts the permission to turn-permission with the sandbox token and never replies', async () => {
    await relayPermissionToApi(REQUEST)

    expect(requests).toHaveLength(1)
    expect(requests[0]!.method).toBe('POST')
    expect(requests[0]!.path).toBe('/v1/projects/proj-1/turn-permission')
    expect(requests[0]!.auth).toBe('Bearer sandbox-token')
    expect(requests[0]!.body).toEqual({
      session_id: 'sess-1',
      request_id: 'per_1',
      opencode_session_id: 'ses_root',
      permission: 'bash',
      patterns: ['git push *'],
    })
    expect(requests.some((r) => r.path.startsWith('/permission'))).toBe(false)
  })

  test('a non-2xx response is swallowed', async () => {
    status = 500
    await expect(relayPermissionToApi(REQUEST)).resolves.toBeUndefined()
    expect(requests).toHaveLength(1)
  })

  test('an unreachable API is swallowed', async () => {
    process.env.KORTIX_API_URL = 'http://127.0.0.1:1'
    await expect(relayPermissionToApi(REQUEST)).resolves.toBeUndefined()
    expect(requests).toHaveLength(0)
  })

  test('without a control plane nothing is sent', async () => {
    delete process.env.KORTIX_API_URL
    await relayPermissionToApi(REQUEST)
    expect(requests).toHaveLength(0)
  })
})

describe('dispatch — permission.asked', () => {
  test('hands a well-formed request to onPermissionAsked', () => {
    const got: PermissionRequest[] = []
    dispatch({ type: 'permission.asked', properties: REQUEST }, { onPermissionAsked: (r) => got.push(r) })
    expect(got).toEqual([REQUEST])
  })

  test('drops a frame without an id or session id', () => {
    const got: PermissionRequest[] = []
    dispatch(
      { type: 'permission.asked', properties: { sessionID: 'ses_root', permission: 'bash' } },
      { onPermissionAsked: (r) => got.push(r) },
    )
    dispatch(
      { type: 'permission.asked', properties: { id: 'per_2', permission: 'bash' } },
      { onPermissionAsked: (r) => got.push(r) },
    )
    expect(got).toHaveLength(0)
  })

  test('still reaches onEvent for the runtime projection', () => {
    const seen: string[] = []
    dispatch(
      { type: 'permission.asked', properties: REQUEST },
      { onEvent: (e) => seen.push(e.type ?? ''), onPermissionAsked: () => {} },
    )
    expect(seen).toEqual(['permission.asked'])
  })
})
