/**
 * Re-arming the shim while the session is already up.
 *
 * The listener is started twice in a daemon's life — cold boot and fork
 * adoption — and a boundary secret added afterwards used to reach a box that
 * had already decided it needed no shim. The catalog landed, opencode
 * respawned, and the respawn spread an `egressShimEnv()` that was still empty:
 * the secret did nothing at all until the session was restarted.
 *
 * These bind a real listener rather than a fake, because the two things most
 * likely to go wrong here are exactly the ones a fake cannot show — that the
 * port is actually released before the rebind, and that the exported proxy env
 * is really gone once the rules are withdrawn.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import net from 'node:net'

import {
  __resetEgressShimForTests,
  egressShimEnv,
  stopEgressShim,
  syncEgressShim,
} from './index'

interface TestRule {
  identifier: string
  hosts: string[]
}

/**
 * A fresh kernel-assigned port per test, never a fixed number. The CI packages
 * lane can run this suite concurrently with — or right on the heels of —
 * another run on the same runner, and two processes sharing one fixed port
 * turn every "nothing listens here" assertion and the stop-then-rebind cycle
 * into flakes. The ephemeral range is also inherently clear of the daemon's
 * own 4319/4320/4321 block.
 */
function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

function sessionEnv(port: number, rules: TestRule[]): NodeJS.ProcessEnv {
  return {
    KORTIX_EGRESS_SHIM_PORT: String(port),
    KORTIX_API_URL: 'https://api.kortix.test/v1',
    KORTIX_PROJECT_ID: 'proj-sync',
    KORTIX_TOKEN: 'kortix_pat_sync',
    KORTIX_SECRET_CAPABILITIES: JSON.stringify({
      version: 1,
      capabilities: rules.map((rule) => ({ ...rule, delivery: 'network' })),
    }),
  } as NodeJS.ProcessEnv
}

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

let squatter: net.Server | null = null

afterEach(async () => {
  stopEgressShim()
  __resetEgressShimForTests()
  if (squatter) {
    const server = squatter
    squatter = null
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe('syncEgressShim', () => {
  test('a session that never had boundary rules and still has none arms nothing', async () => {
    const port = await ephemeralPort()
    const result = await syncEgressShim(sessionEnv(port, []))

    expect(result.outcome).toBe('unchanged')
    expect(egressShimEnv()).toEqual({})
    expect(await isListening(port)).toBe(false)
  })

  test("the session's first boundary secret starts a listener mid-flight", async () => {
    const port = await ephemeralPort()
    const result = await syncEgressShim(
      sessionEnv(port, [{ identifier: 'WEATHER_API', hosts: ['api.weather.test'] }]),
    )

    expect(result.outcome).toBe('started')
    expect(result.hosts).toEqual(['api.weather.test'])
    expect(egressShimEnv().HTTPS_PROXY).toBe(`http://127.0.0.1:${port}`)
    expect(await isListening(port)).toBe(true)
  })

  test('re-pushing the same rules leaves the running listener untouched', async () => {
    const port = await ephemeralPort()
    const rules = [
      { identifier: 'WEATHER_API', hosts: ['api.weather.test', 'cdn.weather.test'] },
      { identifier: 'PAY_KEY', hosts: ['api.pay.test'] },
    ]
    expect((await syncEgressShim(sessionEnv(port, rules))).outcome).toBe('started')
    const armed = egressShimEnv()

    // Same rule set, re-ordered — the fan-out that carries the catalog fires on
    // every secret-CRUD push, not only the ones that move a boundary rule. A
    // restart here would drop the agent's in-flight tunnels for nothing.
    const result = await syncEgressShim(
      sessionEnv(port, [
        { identifier: 'PAY_KEY', hosts: ['api.pay.test'] },
        { identifier: 'WEATHER_API', hosts: ['cdn.weather.test', 'api.weather.test'] },
      ]),
    )

    expect(result.outcome).toBe('unchanged')
    // Identity, not equality: a restart mints a new env object even when the
    // port and the paths come out the same.
    expect(egressShimEnv()).toBe(armed)
    expect(await isListening(port)).toBe(true)
  })

  test('widening a rule restarts the listener', async () => {
    const port = await ephemeralPort()
    expect(
      (
        await syncEgressShim(
          sessionEnv(port, [{ identifier: 'WEATHER_API', hosts: ['api.weather.test'] }]),
        )
      ).outcome,
    ).toBe('started')

    const result = await syncEgressShim(
      sessionEnv(port, [
        { identifier: 'WEATHER_API', hosts: ['api.weather.test', 'cdn.weather.test'] },
      ]),
    )

    expect(result.outcome).toBe('restarted')
    expect([...result.hosts].sort()).toEqual(['api.weather.test', 'cdn.weather.test'])
    expect(await isListening(port)).toBe(true)
  })

  test('withdrawing the last boundary secret stops the listener and clears the proxy env', async () => {
    const port = await ephemeralPort()
    expect(
      (
        await syncEgressShim(
          sessionEnv(port, [{ identifier: 'WEATHER_API', hosts: ['api.weather.test'] }]),
        )
      ).outcome,
    ).toBe('started')

    const result = await syncEgressShim(sessionEnv(port, []))

    expect(result.outcome).toBe('stopped')
    // Leaving HTTPS_PROXY exported at a dead listener is worse than never
    // arming one: every HTTPS call the agent makes would fail to connect.
    expect(egressShimEnv()).toEqual({})
    expect(await isListening(port)).toBe(false)
  })

  test('a listener that cannot bind reports failure instead of throwing', async () => {
    // The squatter binds first and OWNS the port the shim is pointed at, so
    // the collision is deterministic instead of racing another process for it.
    squatter = net.createServer()
    await new Promise<void>((resolve) => squatter!.listen(0, '127.0.0.1', () => resolve()))
    const port = (squatter.address() as net.AddressInfo).port

    const result = await syncEgressShim(
      sessionEnv(port, [{ identifier: 'WEATHER_API', hosts: ['api.weather.test'] }]),
    )

    expect(result.outcome).toBe('failed')
    expect(result.error).toBeTruthy()
    expect(egressShimEnv()).toEqual({})
  })

  test('a session missing the credential the broker needs does not arm', async () => {
    // Fails closed, same as boot: no CLI token means nothing can spend the
    // secret, so a listener would accept the connection and then have nothing
    // to relay with.
    const port = await ephemeralPort()
    const env = sessionEnv(port, [{ identifier: 'WEATHER_API', hosts: ['api.weather.test'] }])
    delete env.KORTIX_TOKEN

    const result = await syncEgressShim(env)

    expect(result.outcome).toBe('unchanged')
    expect(egressShimEnv()).toEqual({})
    expect(await isListening(port)).toBe(false)
  })
})
