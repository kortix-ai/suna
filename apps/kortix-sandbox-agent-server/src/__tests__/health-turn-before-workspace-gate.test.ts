/**
 * `/kortix/health?turn=1` must not reach OpenCode before the boot path opens
 * the workspace gate.
 *
 * The turn read is directory-scoped, so it builds OpenCode's Instance. Built
 * before the boot link moves to the release, that Instance keeps the composed
 * config of the early spawn (the governance the box was created with) and the
 * boot path never restarts it. Seen on a persistent machine's wake: the box
 * reported the latest release and ran its creation-day agent prompt.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Config } from '@/lib/config/config'
import type { Opencode } from '@/harness/open-code/lifecycle'
import { createOpenCodeDiagnosticsService } from '@/harness/open-code/diagnostics'

const requests: string[] = []
let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      requests.push(`${url.pathname}${url.search}`)
      if (url.pathname === '/session/status') return Response.json({})
      if (url.pathname.endsWith('/message')) return Response.json([])
      return Response.json({ id: 'ses_test' })
    },
  })
})

afterAll(() => server.stop(true))

async function healthTurn(workspaceReady: boolean | undefined) {
  const diagnostics = createOpenCodeDiagnosticsService({
    getState: () => 'ok',
    getPid: () => 4242,
    getActivePort: () => 4096,
    getInternalUrl: () => `http://127.0.0.1:${server.port}`,
  } as unknown as Opencode)
  return diagnostics.health(
    {
      cfg: { autoClone: false, workspace: '/workspace' } as unknown as Config,
      bootTime: Date.now(),
      bootState: { timeline: [], repoMaterializationError: null, workspaceReady },
      staticWebPort: 3211,
      resources: () => null,
    },
    { turn: { sessionId: 'ses_test' } },
  )
}

describe('health turn read and the workspace gate', () => {
  test('before the gate opens: no request reaches OpenCode, the turn is unknown', async () => {
    requests.length = 0
    const report = await healthTurn(false)
    expect(requests).toEqual([])
    expect(report.harness.turn?.in_flight).toBeNull()
  })

  test('after the gate opens: the turn is read from OpenCode', async () => {
    requests.length = 0
    await healthTurn(true)
    expect(requests.some((path) => path.includes('directory='))).toBe(true)
  })
})
