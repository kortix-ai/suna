import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as shared from '../../../../../packages/shared/src/workspace-routes'
import {
  kortixApiFetch,
  legacyWorkspaceRoute,
  resetWorkspaceRouteMemory,
  withWorkspaceRouteFallback,
} from './workspace-routes'

// kortixd calls the canonical `/v1/workspaces` names. An API that predates
// them answers the framework's unknown-route 404; kortixd then sends the same
// request once more on the legacy name and remembers the base.

const NOT_FOUND = { error: true, message: 'Not found', status: 404 }

function oldServer() {
  const seen: Array<{ method: string; url: string; body: string | null }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = (input instanceof Request ? input.method : init?.method) ?? 'GET'
    seen.push({ method, url, body: typeof init?.body === 'string' ? init.body : null })
    const path = new URL(url).pathname
    if (path.endsWith('/missing')) return Response.json({ error: 'Session not found' }, { status: 404 })
    if (legacyWorkspaceRoute(path) !== null) return Response.json(NOT_FOUND, { status: 404 })
    return Response.json({ path })
  }) as typeof fetch
  return { seen, fetchImpl }
}

beforeEach(() => resetWorkspaceRouteMemory())
afterEach(() => resetWorkspaceRouteMemory())

describe('the kortixd copy of the workspace route map', () => {
  test('maps every path exactly like @kortix/shared', () => {
    for (const path of [
      '/v1/workspaces',
      '/v1/workspaces/p1/sessions/s1/log/journal',
      '/v1/workspaces/a1/members',
      '/v1/workspaces/a1/secret-resources/x',
      '/v1/me',
      '/v1/invites/i1',
      '/v1/connectors/workspaces/p1/x',
      '/scim/v2/workspaces/a1/Users',
      '/v1/projects/p1',
      '/v1/workspaces/p1/audit/events',
      '/v1/webhooks/workspaces/p1/hook',
      '/v1/billing',
      '/v1/p/ext/8000/v1/me',
    ]) {
      expect({ path, legacy: legacyWorkspaceRoute(path) }).toEqual({ path, legacy: shared.legacyWorkspaceRoute(path) })
    }
  })
})

describe('withWorkspaceRouteFallback', () => {
  test('an old API: one unknown-route 404, then the legacy name; the base is remembered', async () => {
    const s = oldServer()
    const f = withWorkspaceRouteFallback(s.fetchImpl)
    const first = await f('http://api.test/v1/workspaces/p1/sessions/s1/turn-stream?x=1', { method: 'POST', body: '{"a":1}' })
    expect(await first.json()).toEqual({ path: '/v1/projects/p1/sessions/s1/turn-stream' })
    await f('http://api.test/v1/workspaces/p1/detail')
    expect(s.seen).toEqual([
      { method: 'POST', url: 'http://api.test/v1/workspaces/p1/sessions/s1/turn-stream?x=1', body: '{"a":1}' },
      { method: 'POST', url: 'http://api.test/v1/projects/p1/sessions/s1/turn-stream?x=1', body: '{"a":1}' },
      { method: 'GET', url: 'http://api.test/v1/projects/p1/detail', body: null },
    ])
  })

  test('a current API answers the canonical name: one request', async () => {
    const seen: string[] = []
    const f = withWorkspaceRouteFallback((async (input: string | URL | Request) => {
      seen.push(String(input))
      return Response.json({ ok: true })
    }) as typeof fetch)
    await f(new URL('http://api.test/v1/workspaces/p1/runtime/prompt-attachments/a1?command_id=c'))
    expect(seen).toEqual(['http://api.test/v1/workspaces/p1/runtime/prompt-attachments/a1?command_id=c'])
  })

  test('a handler 404 never retries', async () => {
    const s = oldServer()
    const res = await withWorkspaceRouteFallback(s.fetchImpl)('http://api.test/v1/workspaces/p1/sessions/missing')
    expect(res.status).toBe(404)
    expect(s.seen).toHaveLength(1)
  })

  test('kortixApiFetch reads globalThis.fetch at call time', async () => {
    const s = oldServer()
    const original = globalThis.fetch
    globalThis.fetch = s.fetchImpl
    try {
      await kortixApiFetch('http://api.test/v1/me')
    } finally {
      globalThis.fetch = original
    }
    expect(s.seen.map((r) => r.url)).toEqual(['http://api.test/v1/me', 'http://api.test/v1/accounts/me'])
  })
})
